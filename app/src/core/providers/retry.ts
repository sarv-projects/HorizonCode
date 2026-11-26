import type { ProviderFailureCode } from "../../contracts";
import { classifyProviderFailure, isRetryableFailureCode, retryAttemptsForFailureCode } from "./failure-codes";
import {
  createProviderDeadline,
  resolveProviderTimeouts,
  type ProviderTimeoutOptions,
} from "./timeout";

/**
 * retry.ts — transient-failure recovery for provider HTTP calls.
 *
 * Every provider turn begins with one `fetch`. Until this module existed, a
 * single 429 (rate limit), 529 (overloaded) or connection reset failed the whole
 * turn: the loop reported `failed/provider_error` and the user re-typed the
 * request. That is the difference between an agent that stalls and one that
 * rides out a rate limit, and it was the single most likely failure on any long
 * session.
 *
 * Scope is deliberately narrow and safe: only the request phase is retried —
 * the window between sending the request and receiving response headers, where
 * nothing has been emitted downstream yet, so a retry is invisible. Once the
 * stream is open, a failure cannot be replayed without risking duplicated text
 * or a duplicated tool call, so mid-stream errors are surfaced, not retried.
 *
 * Retryable: 408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529 and any
 * connection-level failure — including a response that never sends headers
 * within the configured `timeouts.requestMs`. Everything else (400, 401, 403,
 * 404, 413, 422, …) is returned to the caller untouched — retrying a malformed
 * request only wastes the user's tokens and time.
 *
 * A POST is re-sent, which the provider may have already processed. That is the
 * accepted trade for a chat-completion request with no side effects of its own;
 * the alternative — failing a long turn on one dropped connection — costs far
 * more. Attempts are capped and the delay respects `Retry-After` when the server
 * states one, so a hard rate limit is not hammered.
 */

export interface RetryInfo {
  /** 1-based number of the attempt that just failed (so 1 = first retry). */
  attempt: number;
  /** HTTP status, when the failure was a response rather than a connection error. */
  status?: number;
  /** The thrown error, when the failure was a connection error. */
  error?: unknown;
  /** How long the caller will wait before the next attempt. */
  delayMs: number;
}

export interface RetryPolicy {
  /** Total attempts including the first. Default 4 (one try plus three retries). */
  attempts?: number;
  /** First backoff step; doubles each attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Backoff ceiling, and the cap applied to a server-stated `Retry-After`. Default 20 s. */
  maxDelayMs?: number;
  /** Called before each retry, so a caller can tell the human what is happening. */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Transport timeouts. The request budget applies per attempt (headers), the
   * total budget spans the whole call. Unset fields come from the
   * `HZ_PROVIDER_*` env vars; see providers/timeout.ts.
   */
  timeouts?: ProviderTimeoutOptions;
  /**
   * ADDITIVE (grok circuit-breaker port, Tier 1 #8): when set, the breaker is
   * consulted before each request and fed the outcome. Absent = byte-identical
   * existing behavior. Shedding is advisory and never weakens the Guard.
   */
  breaker?: import("./circuit-breaker").CircuitBreaker;
  /**
   * ADDITIVE: route key for the shared production breaker registry. When
   * `HZ_PROVIDER_CIRCUIT_BREAKER=1`, `fetchWithRetry` consults a per-route
   * breaker automatically (grok port). Absent = no shared breaker.
   */
  breakerRoute?: string;
  /** Optional custom fetch transport (for injectable adapters like google/ollama). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Optional predicate to decline retrying specific transport errors (e.g. local ECONNREFUSED). */
  shouldRetryError?: (err: unknown) => boolean;
}

import { BreakerRegistry, SERVER_BREAKER_CONFIG } from "./circuit-breaker";
import { retryDelayFor, retryPolicyForCode } from "./typed-retry-policy";

const sharedBreakers = new BreakerRegistry(SERVER_BREAKER_CONFIG);
/** Reset the shared breaker registry (tests / explicit operator action). */
export function resetProviderBreakers(): void {
  sharedBreakers.clear();
}
function sharedBreakersEnabled(): boolean {
  const raw = process.env.HZ_PROVIDER_CIRCUIT_BREAKER?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
function typedRetryEnabled(): boolean {
  const raw = process.env.HZ_TYPED_RETRY_POLICY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 20_000;

/** The default attempt count, exported so a notice can name it honestly. */
export const DEFAULT_RETRY_ATTEMPTS = DEFAULT_ATTEMPTS;

/** Statuses worth a second attempt: rate limits, overload, and transient server faults. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Status retry OR a classified code that is still transient/rate/overload. */
export function shouldRetryHttpFailure(status: number, body?: string): boolean {
  if (!isRetryableStatus(status)) return false;
  const code = classifyProviderFailure(status, body);
  return isRetryableFailureCode(code);
}

/** Minimal header surface (`Headers` from fetch, or a plain record). */
export type RetryHeaderLike = Headers | Record<string, string | undefined> | null | undefined;

function headerValue(headers: RetryHeaderLike, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, unknown>;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

/**
 * ADAPT opencode `model-retry.ts`: a provider may state `x-should-retry` on an
 * error response to override the local heuristic. `"true"` forces a retry,
 * `"false"` forbids one; anything else (or absent) defers to classification.
 * Additive seam — callers that never pass headers keep today's behavior.
 */
export function retryOverrideFromHeaders(headers: RetryHeaderLike): boolean | undefined {
  const raw = headerValue(headers, "x-should-retry")?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/** Header override first, then the normal status/code classification. */
export function shouldRetryResponse(status: number, body?: string, headers?: RetryHeaderLike): boolean {
  const override = retryOverrideFromHeaders(headers);
  if (override !== undefined) return override;
  return shouldRetryHttpFailure(status, body);
}

export { classifyProviderFailure, isRetryableFailureCode, retryAttemptsForFailureCode };

export function effectiveRetryAttempts(policy: RetryPolicy, code?: ProviderFailureCode): number {
  const base = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_ATTEMPTS));
  return retryAttemptsForFailureCode(code, base);
}

/**
 * `Retry-After` in milliseconds: the delta-seconds form, or an HTTP date. A
 * value the server did not state, or one that is unparseable, yields `null` and
 * the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/**
 * Exponential backoff with full jitter, floored at `base` so the first retry is
 * never immediate, and never above `max`. A server-stated `Retry-After` wins
 * (clamped to `max`) because guessing lower than the server asked is how a
 * client turns a rate limit into a ban. `random` is injectable for tests.
 */
export function backoffDelay(
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; retryAfterMs?: number | null; random?: () => number } = {},
): number {
  const base = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const max = Math.max(base, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const retryAfter = options.retryAfterMs;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter, max);
  }
  const step = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  const random = options.random ?? Math.random;
  // Full jitter over [step/2, step]: spreads concurrent clients without letting
  // the wait collapse to zero.
  return Math.min(max, Math.floor(step / 2 + random() * (step / 2)));
}

/**
 * An abortable sleep. Resolves early — rather than rejecting — when the signal
 * fires, so the caller re-checks `signal.aborted` and unwinds normally instead
 * of having to catch a synthetic abort error here.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!(ms > 0) || signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch` with bounded retries for transient failures.
 *
 * Returns the first non-retryable response (including a retryable status on the
 * final attempt, which the caller surfaces as an error with the server's own
 * text). Throws the last connection error if every attempt failed at the
 * transport level, and throws immediately when the signal was aborted.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  policy: RetryPolicy = {},
): Promise<Response> {
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeouts = resolveProviderTimeouts(policy.timeouts);
  const userSignal = init.signal ?? undefined;
  // The total budget spans every attempt. The adapters run the returned body
  // under their own total/idle deadline (this one is disposed on return), but
  // it still bounds retries and a stalled error-body read.
  const overall = createProviderDeadline(userSignal, { requestMs: 0, totalMs: timeouts.totalMs });
  let lastError: unknown;
  let attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_ATTEMPTS));

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const expired = overall.timedOut();
      if (expired) throw expired;
      if (userSignal?.aborted === true) throw lastError ?? new Error("aborted before request");
      // Circuit breaker: shed before spending a request. A rejection is a
      // typed BreakerOpenError carrying Retry-After for the caller to surface.
      const activeBreaker =
        policy.breaker ??
        (sharedBreakersEnabled() && policy.breakerRoute
          ? sharedBreakers.forRoute(policy.breakerRoute)
          : undefined);
      activeBreaker?.check();
      // Each attempt gets its own headers budget; merging with the overall
      // signal keeps both the total cap and the caller's abort wired in.
      const attemptDeadline = createProviderDeadline(overall.signal, {
        requestMs: timeouts.requestMs,
        totalMs: 0,
      });
      const transport = policy.fetch ?? ((target: string, options?: RequestInit) => fetch(target, options));
      try {
        const response = await transport(url, { ...init, signal: attemptDeadline.signal });
        attemptDeadline.headersReceived();
        attemptDeadline.dispose();
        const lateTimeout = attemptDeadline.timedOut();
        if (lateTimeout) {
          try {
            await response.body?.cancel();
          } catch {
            /* the body is already gone */
          }
          throw lateTimeout;
        }
        const headerOverride = retryOverrideFromHeaders(response.headers);
        if (headerOverride !== true && !isRetryableStatus(response.status)) {
          if (response.status >= 200 && response.status < 300) {
            activeBreaker?.record("success");
          } else if (activeBreaker?.isFailureStatus(response.status)) {
            activeBreaker.record("failure");
          }
          return response;
        }
        if (response.status >= 200 && response.status < 300) {
          activeBreaker?.record("success");
        } else {
          activeBreaker?.record("failure");
        }
        const detail = await response.text().catch(() => "");
        const expiredDuringBody = attemptDeadline.timedOut() ?? overall.timedOut();
        if (expiredDuringBody) throw expiredDuringBody;
        const code = classifyProviderFailure(response.status, detail);
        if (headerOverride !== true) {
          attempts = Math.min(attempts, effectiveRetryAttempts(policy, code));
        }
        if (!shouldRetryResponse(response.status, detail, response.headers) || attempt >= attempts) {
          return new Response(detail, { status: response.status, headers: response.headers });
        }
        // Typed policy (codex port, opt-in): terminal never retries; server-
        // directed refuses without Retry-After; backoff/fallback use advice or
        // exponential backoff. Absent env = byte-identical existing behavior.
        let waitMs: number;
        if (typedRetryEnabled() && headerOverride !== true) {
          const typed = retryPolicyForCode(code);
          const decided = retryDelayFor(
            typed,
            attempt,
            parseRetryAfter(response.headers.get("retry-after")) ?? undefined,
          );
          if (decided === null) {
            return new Response(detail, { status: response.status, headers: response.headers });
          }
          waitMs = Math.min(decided, maxDelayMs);
        } else {
          waitMs = backoffDelay(attempt, {
            baseDelayMs,
            maxDelayMs,
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          });
        }
        policy.onRetry?.({ attempt, status: response.status, delayMs: waitMs });
        await delay(waitMs, overall.signal);
      } catch (err) {
        attemptDeadline.dispose();
        const timedOut = attemptDeadline.timedOut() ?? overall.timedOut();
        lastError = timedOut ?? err;
        // A headers timeout is a transport failure like a reset, so it rides
        // the same bounded backoff. An abort is never retried, and a fired
        // total budget is final. User aborts must not trip the circuit breaker.
        if (userSignal?.aborted) throw timedOut ?? err;
        activeBreaker?.record("failure");
        if (timedOut?.kind === "total") throw timedOut;
        if (policy.shouldRetryError !== undefined && !policy.shouldRetryError(lastError)) throw lastError;
        if (attempt >= attempts) throw lastError;
        const waitMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs, retryAfterMs: null });
        policy.onRetry?.({ attempt, error: lastError, delayMs: waitMs });
        await delay(waitMs, overall.signal);
      }
    }
    throw lastError ?? new Error("request failed after retries");
  } finally {
    overall.dispose();
  }
}

/** "retrying in 2s (attempt 2 of 4)" — the human-readable form, shared by both adapters. */
export function retryNotice(provider: string, info: RetryInfo, attempts: number): string {
  const why = typeof info.status === "number" ? `HTTP ${info.status}` : "connection error";
  const seconds = info.delayMs >= 1000 ? `${(info.delayMs / 1000).toFixed(1)}s` : `${info.delayMs}ms`;
  return `${provider}: ${why}; retrying in ${seconds} (attempt ${info.attempt + 1} of ${attempts})`;
}

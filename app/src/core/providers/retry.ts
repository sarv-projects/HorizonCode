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
 * connection-level failure. Everything else (400, 401, 403, 404, 413, 422, …)
 * is returned to the caller untouched — retrying a malformed request only wastes
 * the user's tokens and time.
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
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_ATTEMPTS));
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = init.signal ?? undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted === true) throw lastError ?? new Error("aborted before request");
    try {
      const response = await fetch(url, init);
      if (!isRetryableStatus(response.status) || attempt >= attempts) return response;
      const waitMs = backoffDelay(attempt, {
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
      // Release the failed response before waiting, or an unread body holds the
      // connection open for the whole backoff.
      try {
        await response.body?.cancel();
      } catch {
        /* a body that cannot be cancelled is not a reason to stop retrying */
      }
      policy.onRetry?.({ attempt, status: response.status, delayMs: waitMs });
      await delay(waitMs, signal);
    } catch (err) {
      lastError = err;
      if (signal?.aborted || attempt >= attempts) throw err;
      const waitMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs, retryAfterMs: null });
      policy.onRetry?.({ attempt, error: err, delayMs: waitMs });
      await delay(waitMs, signal);
    }
  }
  throw lastError ?? new Error("request failed after retries");
}

/** "retrying in 2s (attempt 2 of 4)" — the human-readable form, shared by both adapters. */
export function retryNotice(provider: string, info: RetryInfo, attempts: number): string {
  const why = typeof info.status === "number" ? `HTTP ${info.status}` : "connection error";
  const seconds = info.delayMs >= 1000 ? `${(info.delayMs / 1000).toFixed(1)}s` : `${info.delayMs}ms`;
  return `${provider}: ${why}; retrying in ${seconds} (attempt ${info.attempt + 1} of ${attempts})`;
}

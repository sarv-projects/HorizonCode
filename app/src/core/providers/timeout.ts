/**
 * timeout.ts — bounded waits for the provider transport.
 *
 * A provider turn has three ways to run forever if nothing bounds it:
 *
 *  1. the socket is accepted but response headers never arrive (`request`);
 *  2. the whole turn keeps making just enough progress to look alive (`total`);
 *  3. the stream goes quiet mid-answer and the reader waits on a dead socket
 *     (`idle`).
 *
 * The run budget in the loop is only checked between steps, so none of these
 * are covered by it. This module supplies the timers, a merged abort signal and
 * a typed error so the adapters can tell a timeout apart from the human's
 * abort: an abort is reported as `done/abort`, a timeout as a `TRANSIENT`
 * error that names the phase.
 *
 * Defaults may be overridden per adapter (tests inject short values) or by
 * environment: `HZ_PROVIDER_TIMEOUT_MS` (headers), `HZ_PROVIDER_TOTAL_TIMEOUT_MS`
 * (whole request + stream) and `HZ_PROVIDER_IDLE_TIMEOUT_MS` (silent stream).
 * Any value of 0 disables that timer; an unreadable value keeps the default.
 */

import type { ProviderEvent } from "../../contracts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export const REQUEST_TIMEOUT_ENV = "HZ_PROVIDER_TIMEOUT_MS";
export const TOTAL_TIMEOUT_ENV = "HZ_PROVIDER_TOTAL_TIMEOUT_MS";
export const IDLE_TIMEOUT_ENV = "HZ_PROVIDER_IDLE_TIMEOUT_MS";

export type ProviderTimeoutKind = "request" | "total" | "idle";

/** Per-call overrides; every field falls back to its `HZ_PROVIDER_*` env var. */
export interface ProviderTimeoutOptions {
  /** How long the server has to send response headers. */
  requestMs?: number;
  /** Cap on the whole request, including the streamed body. */
  totalMs?: number;
  /** Longest silence tolerated between stream chunks. */
  idleMs?: number;
}

export interface ResolvedProviderTimeouts {
  requestMs: number;
  totalMs: number;
  idleMs: number;
}

/**
 * The error a fired timer produces. `kind` is what lets a caller say *which*
 * budget expired; the adapters turn it into a typed `error` event instead of
 * the `done/abort` a human abort gets.
 */
export class ProviderTimeoutError extends Error {
  readonly name = "ProviderTimeoutError";

  constructor(
    readonly kind: ProviderTimeoutKind,
    readonly timeoutMs: number,
  ) {
    super(
      kind === "request"
        ? `no response headers within ${timeoutMs}ms`
        : kind === "idle"
          ? `no stream data for ${timeoutMs}ms`
          : `total request budget of ${timeoutMs}ms exceeded`,
    );
  }
}

export function isProviderTimeoutError(err: unknown): err is ProviderTimeoutError {
  return err instanceof ProviderTimeoutError;
}

/** An explicit value wins (0 disables); otherwise the env var, then `fallback`. */
function resolveOne(explicit: unknown, envName: string, fallback: number, env: NodeJS.ProcessEnv): number {
  if (typeof explicit === "number") {
    if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
    return fallback;
  }
  const raw = env[envName];
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return fallback;
}

export function resolveProviderTimeouts(
  options: ProviderTimeoutOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderTimeouts {
  return {
    requestMs: resolveOne(options.requestMs, REQUEST_TIMEOUT_ENV, DEFAULT_REQUEST_TIMEOUT_MS, env),
    totalMs: resolveOne(options.totalMs, TOTAL_TIMEOUT_ENV, DEFAULT_TOTAL_TIMEOUT_MS, env),
    idleMs: resolveOne(options.idleMs, IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_MS, env),
  };
}

/** Just the idle budget, for stream readers that take no other options. */
export function resolveIdleTimeoutMs(idleMs?: number, env: NodeJS.ProcessEnv = process.env): number {
  return resolveOne(idleMs, IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_MS, env);
}

/**
 * A live deadline: `signal` aborts when the user aborts or a timer fires,
 * `timedOut()` says which timer (if any) fired, and `dispose()` releases the
 * timers when the body is finished. The user's own signal is never modified.
 */
export interface ProviderDeadline {
  /** Merge of the caller's signal and this deadline's timer. */
  readonly signal: AbortSignal;
  /** Call when response headers arrived: the request timer is no longer needed. */
  headersReceived(): void;
  /** The typed timeout that fired, or `undefined` for a plain user abort. */
  timedOut(): ProviderTimeoutError | undefined;
  /** Clear every outstanding timer. Safe to call more than once. */
  dispose(): void;
}

export function createProviderDeadline(
  userSignal: AbortSignal | undefined,
  options: ProviderTimeoutOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ProviderDeadline {
  const timeouts = resolveProviderTimeouts(options, env);
  const controller = new AbortController();
  let fired: ProviderTimeoutError | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const clear = (timer: ReturnType<typeof setTimeout> | undefined): undefined => {
    if (timer !== undefined) clearTimeout(timer);
    return undefined;
  };
  const fire = (kind: ProviderTimeoutKind, timeoutMs: number): void => {
    // A human abort that won the race is reported as an abort, never relabelled
    // as a timeout when a timer happens to fire afterwards.
    if (fired !== undefined || controller.signal.aborted || userSignal?.aborted === true) return;
    fired = new ProviderTimeoutError(kind, timeoutMs);
    controller.abort(fired);
  };

  if (timeouts.requestMs > 0) {
    requestTimer = setTimeout(() => fire("request", timeouts.requestMs), timeouts.requestMs);
  }
  if (timeouts.totalMs > 0) {
    totalTimer = setTimeout(() => fire("total", timeouts.totalMs), timeouts.totalMs);
  }

  // AbortSignal.any is available on the Bun/Node versions this app targets.
  // The caller's abort propagates untouched, so `fired` stays undefined and the
  // adapters report a normal done/abort.
  const signal = userSignal ? AbortSignal.any([userSignal, controller.signal]) : controller.signal;

  return {
    signal,
    headersReceived(): void {
      requestTimer = clear(requestTimer);
    },
    timedOut(): ProviderTimeoutError | undefined {
      return fired;
    },
    dispose(): void {
      requestTimer = clear(requestTimer);
      totalTimer = clear(totalTimer);
    },
  };
}

/**
 * Run a provider stream under a total deadline. The wrapper exists so every
 * early return inside an adapter still disposes the timer through `finally`.
 */
export async function* withProviderDeadline(
  userSignal: AbortSignal | undefined,
  options: ProviderTimeoutOptions,
  run: (deadline: ProviderDeadline) => AsyncIterable<ProviderEvent>,
): AsyncGenerator<ProviderEvent, void, unknown> {
  const totalMs = resolveProviderTimeouts(options).totalMs;
  // The request budget is per attempt (fetchWithRetry / requestWithRetry own
  // it); this deadline only caps the whole turn, stream included.
  const deadline = createProviderDeadline(userSignal, { requestMs: 0, totalMs });
  try {
    yield* run(deadline);
  } finally {
    deadline.dispose();
  }
}

/** The typed error event every adapter emits when one of the timers fired. */
export function providerTimeoutEvent(
  provider: string,
  timeout: ProviderTimeoutError,
  phase: "request" | "stream",
): ProviderEvent {
  const detail =
    timeout.kind === "idle"
      ? `stream timed out: no data for ${timeout.timeoutMs}ms`
      : timeout.kind === "request"
        ? `request timed out: no response headers within ${timeout.timeoutMs}ms`
        : `${phase} timed out: exceeded the ${timeout.timeoutMs}ms total budget`;
  return { type: "error", message: `${provider} ${detail}`, code: "TRANSIENT" };
}

/** The slice of a stream reader the idle guard needs (DOM or node:stream/web). */
export interface IdleGuardReader<T> {
  read(): Promise<{ done: boolean; value?: T }>;
  cancel(reason?: unknown): Promise<void>;
}

/** Minimal structural read result, avoiding a lib-vs-node type mismatch. */
export interface IdleGuardReadResult<T> {
  done: boolean;
  value?: T;
}

/**
 * `reader.read()` with an idle guard. On silence the reader is cancelled (so
 * the socket is released rather than left to the GC) and a typed error is
 * thrown. Timeouts during `read()` that come from the outer signal are left
 * alone; the adapter maps those through its deadline.
 */
export async function readWithIdleTimeout<T>(
  reader: IdleGuardReader<T>,
  idleMs: number,
): Promise<IdleGuardReadResult<T>> {
  if (!(idleMs > 0)) return reader.read();
  return new Promise<IdleGuardReadResult<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void reader.cancel().catch(() => undefined);
      reject(new ProviderTimeoutError("idle", idleMs));
    }, idleMs);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

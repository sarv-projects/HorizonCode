/**
 * cli-hygiene.ts — Zero-dependency P1 CLI hygiene utilities.
 *
 * Covers five cross-platform CLI reliability invariants:
 *   1. Loopback NO_PROXY / no_proxy merging (Bun reads lowercase `no_proxy` alone).
 *   2. Windows port remapping out of Hyper-V / WinNAT / WSL excluded ranges (>= 0x8000 -> 0x7000 | (port & 0xfff)).
 *   3. Bounded stdout/stderr flush before `process.exit` so piped output is never truncated or hung.
 *   4. Signal & teardown deadline handling (SIGTERM -> 143, SIGINT -> 130, 10s unref'd deadline, 2nd-signal immediate exit 1).
 *   5. Stdin-close lease watcher for `--stdio` / headless sidecar modes to prevent orphaned daemons.
 */

export const LOOPBACK_NO_PROXY_ENTRIES = ["127.0.0.1", "localhost", "::1"] as const;
export const DEFAULT_FLUSH_TIMEOUT_MS = 1_500;
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Merges `127.0.0.1`, `localhost`, and `::1` into BOTH `env.NO_PROXY` and
 * `env.no_proxy`, preserving existing entries and deduplicating them.
 * Bun reads lowercase `no_proxy` alone whenever set, so both spellings receive
 * the identical merged list.
 */
export function applyLoopbackNoProxy(
  env: Record<string, string | undefined> = process.env,
): string {
  const merged = [
    ...new Set(
      [env.NO_PROXY, env.no_proxy, LOOPBACK_NO_PROXY_ENTRIES.join(",")].flatMap((value) =>
        (value ?? "").split(",").flatMap((entry) => {
          const trimmed = entry.trim();
          return trimmed.length > 0 ? [trimmed] : [];
        }),
      ),
    ),
  ].join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;
  return merged;
}

/**
 * On Windows (`win32`), remaps default ports >= 0x8000 (32768) into
 * `0x7000 | (port & 0xfff)` to avoid Hyper-V, WinNAT, and WSL mirrored
 * networking excluded ephemeral port ranges.
 * Leaves `port === 0` (ephemeral), non-positive values, ports < 0x8000, and
 * non-Windows platforms unchanged.
 */
export function remapWindowsPort(
  port: number,
  platform: NodeJS.Platform | string = process.platform,
): number {
  if (!Number.isInteger(port) || port <= 0) return port;
  if (platform === "win32" && port >= 0x8000) {
    return 0x7000 | (port & 0xfff);
  }
  return port;
}

export interface FlushableStream {
  writableEnded?: boolean;
  destroyed?: boolean;
  end?: (cb?: () => void) => unknown;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface FlushExitDeps {
  stdout?: FlushableStream;
  stderr?: FlushableStream;
  exit?: (code: number) => void;
}

function flushSingleStream(stream: FlushableStream | undefined): Promise<void> {
  if (!stream || stream.writableEnded || stream.destroyed || typeof stream.end !== "function") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (typeof stream.off === "function") stream.off("error", finish);
      else if (typeof stream.removeListener === "function") stream.removeListener("error", finish);
      resolve();
    };
    if (typeof stream.once === "function") stream.once("error", finish);
    try {
      stream.end(finish);
    } catch {
      finish();
    }
  });
}

/**
 * Awaits `stdout` and `stderr` drain/end (bounded by `timeoutMs` so a blocked
 * pipe can never hang exit) before calling `process.exit(code)`.
 */
export async function flushStreamsAndExit(
  code: number,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  deps?: FlushExitDeps,
): Promise<void> {
  const stdout = deps?.stdout ?? (process.stdout as unknown as FlushableStream);
  const stderr = deps?.stderr ?? (process.stderr as unknown as FlushableStream);
  const exit = deps?.exit ?? ((exitCode: number) => process.exit(exitCode));
  const boundedMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_FLUSH_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boundedMs);
  });

  try {
    await Promise.race([
      Promise.all([flushSingleStream(stdout), flushSingleStream(stderr)]),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  exit(code);
}

export type TrackedSignal = "SIGTERM" | "SIGINT";

export interface SignalTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface SignalHandlerOptions {
  /** Async or sync teardown callback invoked on first signal. */
  onShutdown?: (signal: TrackedSignal) => void | Promise<void>;
  /** Max teardown window before forcing exit (default: 10_000ms). */
  deadlineMs?: number;
  /** Exit code for SIGTERM (default: 143). */
  sigtermExitCode?: number;
  /** Exit code for SIGINT (default: 130). */
  sigintExitCode?: number;
  /** Exit code on second signal or deadline expiry (default: 1). */
  forceExitCode?: number;
  /** Whether to listen to SIGINT in addition to SIGTERM (default: true). */
  handleSigint?: boolean;
  /** Optional stderr writer for deadline / second-signal notices. */
  stderrWrite?: (chunk: string) => unknown;
  /** Normal exit handler called after teardown completes (default: flushStreamsAndExit). */
  exit?: (code: number) => void;
  /** Immediate exit handler for second signal or deadline expiry (default: process.exit). */
  forceExit?: (code: number) => void;
  /** Injectable process-like emitter for unit tests (default: process). */
  target?: SignalTarget;
}

export interface SignalHandlerController {
  /** True once SIGTERM has been received. */
  readonly terminated: boolean;
  /** True once SIGTERM or SIGINT has initiated shutdown. */
  readonly shuttingDown: boolean;
  /** First signal received, if any. */
  readonly signal: TrackedSignal | undefined;
  /** Maps exit code so SIGTERM -> 143 and SIGINT -> 130 when applicable. */
  resolveExitCode(code: number): number;
  /** Unregisters signal listeners and clears any pending deadline timer. */
  dispose(): void;
}

/**
 * Installs SIGTERM (and optionally SIGINT) handlers with:
 * - `terminated` tracking so SIGTERM exits with 143 (and SIGINT with 130),
 * - a second-signal immediate exit (code 1) during teardown,
 * - an `unref()`'d 10s shutdown deadline so hung teardown never zombies the CLI.
 */
export function installSignalAndExitHandlers(
  opts: SignalHandlerOptions = {},
): SignalHandlerController {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const sigtermExitCode = opts.sigtermExitCode ?? 143;
  const sigintExitCode = opts.sigintExitCode ?? 130;
  const forceExitCode = opts.forceExitCode ?? 1;
  const handleSigint = opts.handleSigint !== false;
  const stderrWrite = opts.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));
  const forceExit = opts.forceExit ?? ((code: number) => process.exit(code));
  const exit = opts.exit ?? ((code: number) => {
    void flushStreamsAndExit(code);
  });
  const target: SignalTarget = opts.target ?? (process as unknown as SignalTarget);

  let terminated = false;
  let shuttingDown = false;
  let firstSignal: TrackedSignal | undefined;
  let disposed = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDeadline = (): void => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  };

  const handleSignal = (signal: TrackedSignal): void => {
    if (disposed) return;

    if (shuttingDown) {
      clearDeadline();
      try {
        stderrWrite(`hzcode: received ${signal} again during shutdown; exiting immediately\n`);
      } catch {
        /* best effort */
      }
      forceExit(forceExitCode);
      return;
    }

    shuttingDown = true;
    firstSignal = signal;
    if (signal === "SIGTERM") terminated = true;

    const exitCode = signal === "SIGTERM" ? sigtermExitCode : sigintExitCode;

    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      try {
        stderrWrite(`hzcode: shutdown did not finish within ${deadlineMs}ms; forcing exit\n`);
      } catch {
        /* best effort */
      }
      forceExit(forceExitCode);
    }, deadlineMs);
    if (typeof (deadlineTimer as { unref?: () => void }).unref === "function") {
      (deadlineTimer as { unref: () => void }).unref();
    }

    if (opts.onShutdown) {
      void Promise.resolve()
        .then(() => opts.onShutdown!(signal))
        .catch(() => undefined)
        .finally(() => {
          if (disposed) return;
          clearDeadline();
          exit(exitCode);
        });
    } else {
      clearDeadline();
      exit(exitCode);
    }
  };

  const onSigterm = (): void => handleSignal("SIGTERM");
  const onSigint = (): void => handleSignal("SIGINT");

  target.on("SIGTERM", onSigterm);
  if (handleSigint) target.on("SIGINT", onSigint);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearDeadline();
    if (typeof target.off === "function") {
      target.off("SIGTERM", onSigterm);
      if (handleSigint) target.off("SIGINT", onSigint);
    } else if (typeof target.removeListener === "function") {
      target.removeListener("SIGTERM", onSigterm);
      if (handleSigint) target.removeListener("SIGINT", onSigint);
    }
  };

  return {
    get terminated() {
      return terminated;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    get signal() {
      return firstSignal;
    },
    resolveExitCode(code: number): number {
      if (terminated && (code === 0 || code === sigintExitCode)) return sigtermExitCode;
      if (firstSignal === "SIGINT" && code === 0) return sigintExitCode;
      return code;
    },
    dispose,
  };
}

export interface WatchableStdin {
  once(event: "end" | "close", listener: () => void): unknown;
  off?(event: "end" | "close", listener: () => void): unknown;
  removeListener?(event: "end" | "close", listener: () => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  readableEnded?: boolean;
  destroyed?: boolean;
}

export interface WatchStdinCloseOptions {
  /**
   * Call `stdin.resume()` so paused streams emit `"end"` (default: true).
   * Pass `false` when a separate worker/reader consumes fd 0 directly.
   */
  resume?: boolean;
}

/**
 * Watches `stdin` for `end` / `close` so parent death in `--stdio` / headless
 * sidecar modes triggers clean server shutdown with zero orphaned daemons.
 * Returns a dispose callback that removes listeners cleanly.
 */
export function watchStdinClose(
  onClose: () => void,
  stdin: WatchableStdin = process.stdin as unknown as WatchableStdin,
  opts?: WatchStdinCloseOptions,
): () => void {
  let closed = false;
  let disposed = false;
  const shouldResume = opts?.resume !== false;

  const removeListeners = (): void => {
    if (typeof stdin.off === "function") {
      stdin.off("end", handleClose);
      stdin.off("close", handleClose);
    } else if (typeof stdin.removeListener === "function") {
      stdin.removeListener("end", handleClose);
      stdin.removeListener("close", handleClose);
    }
    if (shouldResume && typeof stdin.pause === "function") {
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
    }
  };

  const handleClose = (): void => {
    if (closed || disposed) return;
    closed = true;
    removeListeners();
    onClose();
  };

  if (stdin.readableEnded || stdin.destroyed) {
    closed = true;
    onClose();
    return () => {
      disposed = true;
    };
  }

  stdin.once("end", handleClose);
  stdin.once("close", handleClose);
  if (shouldResume && typeof stdin.resume === "function") {
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    removeListeners();
  };
}

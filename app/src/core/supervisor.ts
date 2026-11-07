/**
 * supervisor.ts — the owner-death supervisor (NF-071 process ownership).
 *
 * A long-lived child must not survive its owner. The owner may die without
 * running any cleanup code — SIGKILL, OOM, a killed terminal — so the cleanup
 * cannot live in the owner. It lives in a tiny POSIX `sh` loop that watches
 * both pids:
 *
 *   while kill -0 OWNER 2>/dev/null && kill -0 WORKER 2>/dev/null; do sleep 0.1; done
 *   kill -9 -WORKER 2>/dev/null; exit 0
 *
 * Rationale: a poll loop is the portable EOF-equivalent — no pidfd, no
 * event API, no platform matrix, ~0.5 MB resident, detection in ~pollMs
 * (0.1 s default, i.e. at most one sleep interval after the death). The same
 * loop covers both endings: when the WORKER exits, the loop ends and the
 * supervisor exits with it (nothing lingers); when the OWNER dies — any
 * signal, including SIGKILL and OOM — the loop ends and the worker's whole
 * process group is killed with SIGKILL.
 *
 * The worker MUST have been spawned detached (`detached: true`), so it leads
 * its own process group; `kill -9 -WORKER` then reaches the entire child tree,
 * not just the worker. `spawnOwned` enforces that for long-lived children.
 *
 * Known residuals, stated rather than implied:
 *   - pid reuse: the loop tracks a pid number, not a birth identity; a
 *     recycled owner pid would keep it (and the worker) alive. Callers that
 *     care verify with worker-identity.ts.
 *   - the supervisor itself is spawned with node:child_process, deliberately:
 *     routing it through `spawnOwned` would recurse (every owned spawn gets a
 *     supervisor) and `spawnOwned`'s ledger records *workers*. It is detached
 *     and unref'd so a group kill of the owner's group cannot take it down
 *     before it fires, and it never blocks the owner's exit.
 *   - non-POSIX hosts have no `sh`; startOwnerDeathSupervisor then reports
 *     spawn failure to its caller (which fails closed).
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Guardrails: the supervisor polls at least every 10 ms, default 100 ms. */
const MIN_POLL_MS = 10;
const DEFAULT_POLL_MS = 100;

export interface OwnerDeathSupervisorOptions {
  /** The process whose death must take the worker tree down (the owner). */
  ownerPid: number;
  /** The long-lived child (already detached, leading its own process group). */
  workerPid: number;
  /** Poll interval in ms; the sh loop sleeps this long between checks. */
  pollMs?: number;
}

export interface OwnerDeathSupervisor {
  /** The supervisor `sh` process; -1 never appears (start throws instead). */
  readonly pid: number;
  /** Resolves with the supervisor's exit code when it exits on its own. */
  readonly exited: Promise<number | null>;
  /** Best-effort stop, for callers (or tests) that still hold the handle. */
  stop(): void;
}

function requirePid(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`startOwnerDeathSupervisor: ${name} must be a positive integer pid`);
  }
  return value as number;
}

/** The exact shell script, exported so tests can pin it without re-deriving it. */
export function ownerDeathSupervisorScript(ownerPid: number, workerPid: number, pollMs = DEFAULT_POLL_MS): string {
  const owner = requirePid(ownerPid, "ownerPid");
  const worker = requirePid(workerPid, "workerPid");
  const poll = Number.isFinite(pollMs) && pollMs > 0 ? Math.max(MIN_POLL_MS, Math.floor(pollMs)) : DEFAULT_POLL_MS;
  // `sleep 0.1` at the default; only validated integers reach this string.
  const seconds = (poll / 1000).toString();
  return `while kill -0 ${owner} 2>/dev/null && kill -0 ${worker} 2>/dev/null; do sleep ${seconds}; done; kill -9 -${worker} 2>/dev/null; exit 0`;
}

/**
 * Start the owner-death supervisor. It exits by itself once either process is
 * gone, so a caller never needs stop() in normal operation; stop() exists for
 * teardown paths that are tearing everything down anyway.
 */
export function startOwnerDeathSupervisor(opts: OwnerDeathSupervisorOptions): OwnerDeathSupervisor {
  const script = ownerDeathSupervisorScript(opts.ownerPid, opts.workerPid, opts.pollMs);
  const child: ChildProcess = spawn("sh", ["-c", script], {
    stdio: "ignore",
    // Own process group + unref: a killpg of the owner's group must not take the
    // supervisor down before it can fire, and a live supervisor must not keep
    // the owner's event loop alive.
    detached: true,
  });
  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("startOwnerDeathSupervisor: sh did not start");
  }
  const pid = child.pid;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code ?? null));
    child.once("error", () => resolve(null));
  });
  try {
    child.unref();
  } catch {
    /* this runtime has no unref: the supervisor is still correct, just ref'd */
  }
  return {
    pid,
    exited,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

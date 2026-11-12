/**
 * file-lock.ts -- advisory cross-process locks, no dependencies.
 *
 * Two hzcode processes can share one workspace (two terminals, a server beside a
 * TUI, a sub-agent). The in-process queues (`withLock` in kernel.ts, the journal's
 * module state) say nothing about another process, so shared state needs an
 * inter-process mutex. This is the smallest correct one:
 *
 *   - acquire = `open(lockPath, O_CREAT | O_EXCL)`; the file records the holder's
 *     pid and a random token. O_EXCL is atomic on local filesystems.
 *   - a lock whose holder pid is no longer alive is STALE and is reclaimed. A lock
 *     file that is empty (the holder died between create and write) is stale once
 *     it is older than `emptyGraceMs`.
 *   - waiting is bounded (`timeoutMs`); a timeout throws `LockTimeoutError` rather
 *     than proceeding unlocked, so a wedged live holder is reported, not ignored.
 *   - release removes the lock only when it still carries OUR token, so a lock we
 *     lost to a reclaim is never deleted out from under its new owner.
 *
 * Named residuals:
 *   - advisory: only cooperating writers (this module) are serialized; a foreign
 *     editor is still caught by the callers' sha256 preimage checks, not by this lock;
 *   - pid liveness is host-local; on a shared network filesystem across hosts a
 *     live remote holder looks dead. Workspaces on NFS are out of scope;
 *   - pid reuse can keep a dead holder's lock looking live until that pid exits;
 *     `timeoutMs` bounds the damage and the error names the holder;
 *   - the stale-reclaim step (rename aside, verify, restore on mismatch) has a
 *     microsecond window in which two reclaimers can race; the loser restores the
 *     lock with link(2) (which fails if a new owner exists) and keeps waiting;
 *   - when the lock file cannot be created for a reason other than "exists" (read
 *     only directory, EACCES), `withFileLock` runs the work UNLOCKED so that the
 *     caller's own honest write error is what the human sees.
 *   - `HZ_LOCK_BUSY_MARKER` (tests): path written once when an acquire first sees a
 *     live holder, so cross-process fixtures can wait for the waiter without sleeps.
 */

import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./canon";
import { workspaceStateDir } from "./paths";

export interface LockOptions {
  /** Longest wait for a live holder before `LockTimeoutError`. Default 10000. */
  timeoutMs?: number;
  /** First poll interval; grows to `maxPollMs`. Default 5. */
  pollMs?: number;
  /** Poll interval ceiling. Default 50. */
  maxPollMs?: number;
  /** An empty lock file older than this is a crashed acquire. Default 2000. */
  emptyGraceMs?: number;
  /** Injected liveness probe (tests); default is `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

/** Test sync: when set, the first busy poll of an acquire writes this path (pid\\n). */
function signalBusyOnce(signaled: { done: boolean }): void {
  if (signaled.done) return;
  const marker = process.env.HZ_LOCK_BUSY_MARKER;
  if (!marker) return;
  signaled.done = true;
  try {
    writeFileSync(marker, `${process.pid}\n`);
  } catch {
    /* marker is best-effort for tests */
  }
}

export class LockTimeoutError extends Error {
  readonly code = "HZ_LOCK_TIMEOUT";
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | undefined,
    waitedMs: number,
  ) {
    super(
      `HZ_LOCK_TIMEOUT: could not acquire ${lockPath} within ${waitedMs}ms` +
        (holderPid !== undefined ? ` (held by live pid ${holderPid})` : ""),
    );
    this.name = "LockTimeoutError";
  }
}

const DEFAULTS = { timeoutMs: 10_000, pollMs: 5, maxPollMs: 50, emptyGraceMs: 2_000 };

/** Is `pid` a running process? EPERM means it exists but is not ours: alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

interface Holder {
  pid: number;
  token: string;
}

function parseHolder(text: string): Holder | undefined {
  const [pidText, token] = text.split("\n");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || token === undefined || token === "") return undefined;
  return { pid, token };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type Attempt =
  | { kind: "held"; release: () => void }
  | { kind: "busy"; holderPid: number | undefined }
  | { kind: "unlockable" };

/** One non-blocking acquire. Reclaims a stale lock and reports `busy` to retry. */
function tryAcquire(lockPath: string, opts: Required<Omit<LockOptions, "isAlive">> & { isAlive: (pid: number) => boolean }): Attempt {
  const token = randomBytes(8).toString("hex");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      try {
        mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      } catch {
        return { kind: "unlockable" };
      }
      return { kind: "busy", holderPid: undefined };
    }
    if (code !== "EEXIST") return { kind: "unlockable" };
    return reclaimIfStale(lockPath, opts);
  }
  try {
    writeSync(fd, `${process.pid}\n${token}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    kind: "held",
    release: () => {
      try {
        const now = parseHolder(readFileSync(lockPath, "utf8"));
        if (now !== undefined && now.token === token) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

function reclaimIfStale(lockPath: string, opts: { emptyGraceMs: number; isAlive: (pid: number) => boolean }): Attempt {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return { kind: "busy", holderPid: undefined }; // vanished: retry the create
  }
  const holder = parseHolder(text);
  if (holder !== undefined && opts.isAlive(holder.pid)) return { kind: "busy", holderPid: holder.pid };
  if (holder === undefined && Date.now() - mtimeMs < opts.emptyGraceMs) return { kind: "busy", holderPid: undefined };

  // Stale. Move it aside (atomic), confirm it is the lock we judged, else put it back.
  const grave = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, grave);
  } catch {
    return { kind: "busy", holderPid: undefined };
  }
  let moved = "";
  try {
    moved = readFileSync(grave, "utf8");
  } catch {
    /* treat as mismatch below */
  }
  if (moved !== text) {
    try {
      linkSync(grave, lockPath); // fails if a newer owner already exists: fine
    } catch {
      /* someone else owns it now */
    }
  }
  rmSync(grave, { force: true });
  return { kind: "busy", holderPid: undefined };
}

function resolved(opts: LockOptions): Required<LockOptions> {
  return { ...DEFAULTS, isAlive: pidAlive, ...opts };
}

/** Blocking acquire. Returns the release function. Throws `LockTimeoutError`. */
export function acquireLockSync(lockPath: string, options: LockOptions = {}): () => void {
  const opts = resolved(options);
  const start = Date.now();
  let poll = opts.pollMs;
  const signaled = { done: false };
  for (;;) {
    const attempt = tryAcquire(lockPath, opts);
    if (attempt.kind === "held") return attempt.release;
    if (attempt.kind === "unlockable") return () => undefined;
    signalBusyOnce(signaled);
    const waited = Date.now() - start;
    if (waited >= opts.timeoutMs) throw new LockTimeoutError(lockPath, attempt.holderPid, waited);
    sleepSync(poll);
    poll = Math.min(poll * 2, opts.maxPollMs);
  }
}

/** Async acquire: polls with timers so the event loop (and in-process peers) keep running. */
export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<() => void> {
  const opts = resolved(options);
  const start = Date.now();
  let poll = opts.pollMs;
  const signaled = { done: false };
  for (;;) {
    const attempt = tryAcquire(lockPath, opts);
    if (attempt.kind === "held") return attempt.release;
    if (attempt.kind === "unlockable") return () => undefined;
    signalBusyOnce(signaled);
    const waited = Date.now() - start;
    if (waited >= opts.timeoutMs) throw new LockTimeoutError(lockPath, attempt.holderPid, waited);
    await new Promise((resolve) => setTimeout(resolve, poll));
    poll = Math.min(poll * 2, opts.maxPollMs);
  }
}

export function withFileLockSync<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const release = acquireLockSync(lockPath, options);
  try {
    return fn();
  } finally {
    release();
  }
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Where the per-file edit lock for `target` lives: `<state root>/locks/<sha256(target)>.lock`. */
export function targetLockPath(workspace: string, target: string): string {
  return path.join(workspaceStateDir(workspace), "locks", `${sha256Hex(path.resolve(target)).slice(0, 32)}.lock`);
}

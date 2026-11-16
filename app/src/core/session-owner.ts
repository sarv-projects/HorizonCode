/**
 * session-owner.ts — the durable, cross-process OWNER LEASE for a live session.
 *
 * A session transcript has exactly one writer. Before this module existed,
 * `createRuntime` unconditionally ran `repairDanglingToolCalls` (rewriting the
 * message table) and `recoverInterrupted` (settling a `running` admission to
 * `unknown`) on open. A second hzcode process opening the same session could
 * therefore mark a LIVE turn unknown and rewrite rows while the first process
 * was still appending to them — transcript corruption plus a hallucinated
 * interruption.
 *
 * The lease is one row in the `session_owners` table (created by session.ts,
 * migration-safe `CREATE TABLE IF NOT EXISTS`):
 *
 *   session_id PRIMARY KEY · pid · boot_id · start_ticks · epoch · heartbeat_at · host
 *
 * Ownership is exclusive:
 *   - acquire reads the row inside a `BEGIN IMMEDIATE` transaction;
 *   - an existing owner is LIVE unless we can PROVE it is dead: a different
 *     boot id, a dead pid, or a pid whose `/proc/<pid>/stat` start time no
 *     longer matches (pid reuse). Anything uncertain (EPERM, unreadable
 *     /proc, different host) is treated as LIVE — fail closed;
 *   - a provably dead owner is taken over with a compare-and-swap on its
 *     `epoch`, so two contenders cannot both win;
 *   - the row is released on `runtime.close()` and on process exit. A hard
 *     crash leaves the row behind, which the pid/boot/start-ticks check turns
 *     into a safe stale takeover on the next open.
 *
 * `heartbeat_at` is observability only: liveness is decided by pid identity,
 * never by a wall-clock timeout, because a slow-but-live turn must not lose its
 * session and a frozen clock must not steal one.
 *
 * Platform honesty: /proc gives the strong checks on Linux. Elsewhere the pid
 * liveness probe still works, but start ticks are unavailable, so a live pid is
 * trusted (fail closed). A different `host` is also treated as live because we
 * cannot probe it.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { newId, nowIso } from "../contracts";
import { AdmissionQueue } from "./admission";
import type { SessionStore } from "./session";

/** How often a held lease refreshes `heartbeat_at` (observability only). */
export const OWNER_HEARTBEAT_MS = 15_000;

/** The identity of a process attempting to own a session. */
export interface OwnerIdentity {
  /** OS process id. Defaults to the current process. */
  pid: number;
  /** Linux boot id (`/proc/sys/kernel/random/boot_id`); null when unavailable. */
  bootId: string | null;
  /** Field 22 of `/proc/<pid>/stat`; null when unavailable. */
  startTicks: number | null;
  /** Hostname; defaults to `os.hostname()`. */
  host?: string | null;
  /** Unique acquisition epoch; generated when omitted. */
  epoch?: string;
}

/** The persisted owner row. */
export interface SessionOwnerRecord {
  sessionId: string;
  pid: number;
  bootId: string | null;
  startTicks: number | null;
  epoch: string;
  heartbeatAt: string;
  host: string | null;
}

/** The answer to "did this process acquire the session?". */
export type OwnerAcquisition =
  | { acquired: true; owner: SessionOwnerRecord; tookOver: boolean; previous: SessionOwnerRecord | null }
  | { acquired: false; owner: SessionOwnerRecord };

/**
 * Raised when a session is already owned by another process that is provably
 * alive. `createRuntime` turns this into a startup failure instead of running
 * repairs or a turn against another writer's transcript.
 */
export class SessionOwnedError extends Error {
  readonly sessionId: string;
  readonly owner: SessionOwnerRecord;

  constructor(sessionId: string, owner: SessionOwnerRecord) {
    super(
      `session ${sessionId} is already owned by another live hzcode process ` +
        `(pid ${owner.pid} on ${owner.host ?? "unknown host"}, last heartbeat ${owner.heartbeatAt}); ` +
        "refusing to open it concurrently. Close that process, or wait for it to exit and retry.",
    );
    this.name = "SessionOwnedError";
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

interface OwnerDbRow {
  session_id: string;
  pid: number;
  boot_id: string | null;
  start_ticks: number | null;
  epoch: string;
  heartbeat_at: string;
  host: string | null;
}

const OWNER_COLUMNS = "session_id, pid, boot_id, start_ticks, epoch, heartbeat_at, host";

function toRecord(row: OwnerDbRow): SessionOwnerRecord {
  return {
    sessionId: row.session_id,
    pid: Number(row.pid),
    bootId: row.boot_id,
    startTicks: row.start_ticks === null ? null : Number(row.start_ticks),
    epoch: row.epoch,
    heartbeatAt: row.heartbeat_at,
    host: row.host,
  };
}

let cachedBootId: string | null | undefined;

/** The Linux boot id, or null when this platform does not expose one. */
export function readBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = null;
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (value !== "") cachedBootId = value;
  } catch {
    /* non-Linux or /proc unavailable: degrade to pid checks */
  }
  return cachedBootId;
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`, which ticks at boot and is
 * stable for a process's lifetime. A recycled pid has a different value, so it
 * proves the owner we recorded is gone even though the pid is "alive" again.
 */
export function readProcessStartTicks(pid: number): number | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` (field 2) is parenthesised and may itself contain spaces.
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    // Field 3 is fields[0], so field 22 is fields[19].
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The current process's owner identity (pid, boot id, start ticks, host). */
export function currentOwnerIdentity(): OwnerIdentity {
  let host: string | null = null;
  try {
    host = hostname();
  } catch {
    host = null;
  }
  return {
    pid: process.pid,
    bootId: readBootId(),
    startTicks: readProcessStartTicks(process.pid),
    host,
  };
}

function isPidAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but belongs to someone else; any other
    // error is uncertainty. Both are "live" for ownership purposes.
    return undefined;
  }
}

/**
 * Is the recorded owner provably alive? Returns true on any uncertainty (fail
 * closed): a live pid, a different host we cannot probe, or missing /proc data.
 * Returns false only when death is proven: different boot id, dead pid, or a
 * start-ticks mismatch (the pid was reused by a newer process).
 */
export function isOwnerLive(
  owner: SessionOwnerRecord,
  opts: { bootId?: string | null; host?: string | null } = {},
): boolean {
  let currentHost: string | null;
  if (opts.host !== undefined) currentHost = opts.host;
  else {
    try {
      currentHost = hostname();
    } catch {
      currentHost = null;
    }
  }
  if (owner.host !== null && owner.host !== "" && currentHost !== null && owner.host !== currentHost) {
    // Another machine holds it; we cannot probe that pid. Treat as live.
    return true;
  }

  const currentBoot = opts.bootId !== undefined ? opts.bootId : readBootId();
  if (owner.bootId !== null && owner.bootId !== "" && currentBoot !== null && currentBoot !== "") {
    if (owner.bootId !== currentBoot) return false; // the whole machine rebooted
  }

  const alive = isPidAlive(owner.pid);
  if (alive === false) return false; // pid is gone
  if (alive === undefined) return true; // uncertain: fail closed

  if (owner.startTicks !== null) {
    const currentTicks = readProcessStartTicks(owner.pid);
    if (currentTicks !== null && currentTicks !== owner.startTicks) return false; // pid reuse
  }
  return true;
}

function sameIdentity(owner: SessionOwnerRecord, identity: SessionOwnerRecord): boolean {
  return (
    owner.pid === identity.pid &&
    (owner.bootId ?? null) === (identity.bootId ?? null) &&
    (owner.startTicks ?? null) === (identity.startTicks ?? null) &&
    (owner.host ?? null) === (identity.host ?? null)
  );
}

function normalizeIdentity(identity?: OwnerIdentity): SessionOwnerRecord {
  const pid = identity?.pid ?? process.pid;
  const bootId = identity?.bootId !== undefined ? identity.bootId : readBootId();
  const startTicks = identity?.startTicks !== undefined ? identity.startTicks : readProcessStartTicks(pid);
  let fallbackHost: string | null = null;
  try {
    fallbackHost = hostname();
  } catch {
    fallbackHost = null;
  }
  const host = identity?.host !== undefined ? identity.host : fallbackHost;
  return {
    sessionId: "",
    pid,
    bootId,
    startTicks,
    epoch: identity?.epoch ?? newId(),
    heartbeatAt: nowIso(),
    host,
  };
}

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("session owner: sessionId is required");
  }
}

/**
 * A write transaction that takes SQLite's write lock up front (`BEGIN
 * IMMEDIATE`), so two processes cannot both read "no owner" and race an
 * insert/update. `busy_timeout` (set by SessionStore) waits for the other
 * writer instead of failing.
 */
function withImmediateTransaction<T>(db: Database, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = run();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already rolled back */
    }
    throw err;
  }
}

/** The owner row for a session, or null when unowned. */
export function readSessionOwner(store: SessionStore, sessionId: string): SessionOwnerRecord | null {
  requireSessionId(sessionId);
  const row = store.db
    .query(`SELECT ${OWNER_COLUMNS} FROM session_owners WHERE session_id = ?`)
    .get(sessionId) as OwnerDbRow | null | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Acquire ownership for `sessionId`.
 *
 * - no row: inserted and acquired;
 * - our own identity still on the row: refreshed and acquired (a runtime may
 *   re-open a session it already owns, e.g. `switchSession` back);
 * - a live owner: refused (`acquired: false`) with the blocking record;
 * - a provably dead/stale owner: taken over (CAS on the old epoch).
 */
export function acquireOwner(store: SessionStore, sessionId: string, identity?: OwnerIdentity): OwnerAcquisition {
  requireSessionId(sessionId);
  const me = normalizeIdentity(identity);
  me.sessionId = sessionId;

  return withImmediateTransaction(store.db, () => {
    let existing = readSessionOwner(store, sessionId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (existing === null) {
        const record: SessionOwnerRecord = { ...me, heartbeatAt: nowIso() };
        const inserted = store.db.run(
          "INSERT OR IGNORE INTO session_owners (session_id, pid, boot_id, start_ticks, epoch, heartbeat_at, host) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
          [record.sessionId, record.pid, record.bootId, record.startTicks, record.epoch, record.heartbeatAt, record.host],
        );
        if (inserted.changes > 0) {
          return { acquired: true, owner: record, tookOver: false, previous: null };
        }
        // Another process inserted between our read and write; evaluate its row.
        existing = readSessionOwner(store, sessionId);
        if (existing === null) continue;
      }

      if (sameIdentity(existing, me)) {
        const at = nowIso();
        store.db.run("UPDATE session_owners SET heartbeat_at = ? WHERE session_id = ? AND epoch = ?", [
          at,
          sessionId,
          existing.epoch,
        ]);
        return {
          acquired: true,
          owner: { ...existing, heartbeatAt: at },
          tookOver: false,
          previous: existing,
        };
      }

      if (isOwnerLive(existing)) {
        return { acquired: false, owner: existing };
      }

      // Provably dead: take over only if the row is still the one we judged.
      const next: SessionOwnerRecord = { ...me, heartbeatAt: nowIso() };
      const updated = store.db.run(
        "UPDATE session_owners SET pid = ?, boot_id = ?, start_ticks = ?, epoch = ?, heartbeat_at = ?, host = ? " +
          "WHERE session_id = ? AND epoch = ?",
        [next.pid, next.bootId, next.startTicks, next.epoch, next.heartbeatAt, next.host, sessionId, existing.epoch],
      );
      if (updated.changes > 0) {
        return { acquired: true, owner: next, tookOver: true, previous: existing };
      }
      existing = readSessionOwner(store, sessionId);
    }

    const owner = readSessionOwner(store, sessionId);
    if (owner !== null) return { acquired: false, owner };
    throw new Error(`session owner: could not acquire ${sessionId}`);
  });
}

/**
 * Release ownership. When `epoch` is given the delete is a compare-and-swap, so
 * a runtime shutting down can never delete a lease another process has since
 * taken over.
 */
export function releaseOwner(store: SessionStore, sessionId: string, epoch?: string): boolean {
  requireSessionId(sessionId);
  const result =
    epoch === undefined
      ? store.db.run("DELETE FROM session_owners WHERE session_id = ?", [sessionId])
      : store.db.run("DELETE FROM session_owners WHERE session_id = ? AND epoch = ?", [sessionId, epoch]);
  return result.changes > 0;
}

/** Refresh `heartbeat_at`; epoch-scoped when provided. */
export function touchOwner(store: SessionStore, sessionId: string, epoch?: string): boolean {
  requireSessionId(sessionId);
  const result =
    epoch === undefined
      ? store.db.run("UPDATE session_owners SET heartbeat_at = ? WHERE session_id = ?", [nowIso(), sessionId])
      : store.db.run("UPDATE session_owners SET heartbeat_at = ? WHERE session_id = ? AND epoch = ?", [
          nowIso(),
          sessionId,
          epoch,
        ]);
  return result.changes > 0;
}

/** Start an unref'd heartbeat interval; returns its stop function. */
export function startOwnerHeartbeat(
  store: SessionStore,
  sessionId: string,
  epoch: string,
  intervalMs: number = OWNER_HEARTBEAT_MS,
): () => void {
  const every = Number.isFinite(intervalMs) ? Math.max(250, Math.floor(intervalMs)) : OWNER_HEARTBEAT_MS;
  const timer = setInterval(() => {
    try {
      touchOwner(store, sessionId, epoch);
    } catch {
      /* a missed heartbeat never fails a turn; pid identity decides liveness */
    }
  }, every);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

const activeLeases = new Set<SessionOwnerLease>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous best-effort release: another process must not be blocked by a
  // cleanly exited one. A SIGKILL leaves the row, but it is provably stale.
  process.once("exit", () => {
    for (const lease of [...activeLeases]) {
      try {
        lease.release();
      } catch {
        /* the store may already be closed during shutdown */
      }
    }
  });
}

/** A held lease. Release it exactly once; the exit hook is the safety net. */
export class SessionOwnerLease {
  readonly store: SessionStore;
  readonly owner: SessionOwnerRecord;
  readonly tookOver: boolean;
  private stopTimer: (() => void) | undefined;
  private released = false;

  constructor(
    store: SessionStore,
    owner: SessionOwnerRecord,
    opts: { heartbeat?: boolean; heartbeatMs?: number; tookOver?: boolean } = {},
  ) {
    this.store = store;
    this.owner = owner;
    this.tookOver = opts.tookOver === true;
    if (opts.heartbeat !== false) {
      this.stopTimer = startOwnerHeartbeat(store, owner.sessionId, owner.epoch, opts.heartbeatMs);
    }
    activeLeases.add(this);
    installExitHook();
  }

  get sessionId(): string {
    return this.owner.sessionId;
  }

  get epoch(): string {
    return this.owner.epoch;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Refresh the heartbeat now (e.g. at turn start). */
  touch(): boolean {
    if (this.released) return false;
    return touchOwner(this.store, this.owner.sessionId, this.owner.epoch);
  }

  /** Release the lease; idempotent. Returns whether a row was removed. */
  release(): boolean {
    if (this.released) return false;
    this.released = true;
    this.stopTimer?.();
    this.stopTimer = undefined;
    activeLeases.delete(this);
    return releaseOwner(this.store, this.owner.sessionId, this.owner.epoch);
  }
}

/** Options for acquiring a lease through the convenience helpers. */
export interface AcquireOwnerOptions {
  /** Override process identity (tests / diagnostics); defaults to this process. */
  identity?: OwnerIdentity;
  /** Start the heartbeat interval (default true). */
  heartbeat?: boolean;
  heartbeatMs?: number;
}

/** Acquire or throw `SessionOwnedError` when another live process owns it. */
export function acquireOwnedSession(
  store: SessionStore,
  sessionId: string,
  opts: AcquireOwnerOptions = {},
): SessionOwnerLease {
  const result = acquireOwner(store, sessionId, opts.identity);
  if (!result.acquired) throw new SessionOwnedError(sessionId, result.owner);
  return new SessionOwnerLease(store, result.owner, {
    heartbeat: opts.heartbeat,
    heartbeatMs: opts.heartbeatMs,
    tookOver: result.tookOver,
  });
}

/** The result of opening a session for crash recovery. */
export interface SessionRecoveryClaim {
  lease: SessionOwnerLease;
  repaired: { repaired: number; calls: string[] };
  interrupted: string[];
  /** True when the previous owner was provably dead and this process took over. */
  tookOver: boolean;
}

/** `claimSessionForRecovery` options. */
export interface RecoveryClaimOptions extends AcquireOwnerOptions {
  /** The HZ_REEXECUTE_UNPAIRED_TOOL_TAIL escape hatch: skip the transcript repair. */
  reexecTail?: boolean;
}

/**
 * Acquire ownership and THEN run both crash recoveries. This is the one entry
 * point createRuntime uses, so the ordering cannot drift:
 *
 *   1. acquire (or refuse with SessionOwnedError while a live writer holds it);
 *   2. only after a successful acquire: repairDanglingToolCalls (transcript);
 *   3. then recoverInterrupted (admission FIFO).
 *
 * On a live owner nothing is touched. On failure after acquisition the lease is
 * released, so a failed open does not leave an orphaned owner.
 */
export function claimSessionForRecovery(
  store: SessionStore,
  sessionId: string,
  opts: RecoveryClaimOptions = {},
): SessionRecoveryClaim {
  const lease = acquireOwnedSession(store, sessionId, opts);
  try {
    const repaired =
      opts.reexecTail === true ? { repaired: 0, calls: [] as string[] } : store.repairDanglingToolCalls(sessionId);
    const interrupted = new AdmissionQueue(store).recoverInterrupted(sessionId);
    return { lease, repaired, interrupted, tookOver: lease.tookOver };
  } catch (err) {
    lease.release();
    throw err;
  }
}

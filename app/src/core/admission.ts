/**
 * admission.ts — the durable per-session admission FIFO (NF-071).
 *
 * One row per input the runtime accepts for a session, stored in the sessions
 * SQLite database (the `admissions` table created by session.ts). The rules are
 * the RC-7 vocabulary applied to a queue:
 *
 *   - an input is admitted ONCE — `admit` dedupes on the admission id, so
 *     re-delivery cannot insert a second row and cannot reset state. The id is
 *     scoped to a session: the SAME session re-admitting an id is the
 *     documented silent no-op, while an id already owned by a DIFFERENT session
 *     is refused with a typed `AdmissionIdCollisionError` (an id that named two
 *     sessions' inputs would alias their histories);
 *   - `queued` → `running` → one of `done`/`failed`/`unknown`;
 *   - an `unknown` row HALTS its followers: `nextRunnable` returns the oldest
 *     queued row only while no earlier row is unknown. A halted queue is a
 *     refusal state, never an invitation to replay — the effect may or may not
 *     have happened, and replays are how duplicates are born;
 *   - `running` rows found at process start are `unknown` (the turn was
 *     interrupted mid-flight): `recoverInterrupted`;
 *   - only an explicit human/integrator `resolve` moves a halted row out of the
 *     way: `requeue` (safe to run again), `drop` (abandon, never run),
 *     `cancel` (withdraw the work). Nothing in this module replays by itself.
 *
 * Queue order is insertion order (`rowid`): a `requeue`d row resumes its old
 * place and blocks its followers again until it settles. `created_at` is for
 * display and audit; `rowid` is the order of record.
 */

import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../contracts";
import type { SessionStore } from "./session";

/** The six RC-7 admission states, lowercase (the table's CHECK constraint). */
export type AdmissionState = "queued" | "running" | "done" | "unknown" | "failed" | "cancelled";

/** States a turn can settle into; `unknown` is terminal until resolved. */
export type AdmissionSettlement = "done" | "failed" | "unknown";

/** The explicit resolution of a halted (`unknown`) or in-flight row. */
export type AdmissionResolution = "requeue" | "drop" | "cancel";

export interface AdmissionRow {
  id: string;
  sessionId: string;
  input: string;
  state: AdmissionState;
  createdAt: string;
  updatedAt: string;
  evidence: string | null;
}

/**
 * The typed answer to "may a worker start the next turn?".
 * `halted: true` names the row that blocks the queue (always an `unknown` row);
 * `runnable: false` without a halt means the queue is idle or a turn is already
 * running; `runnable: true` carries the row to dispatch.
 */
export type NextRunnable =
  | { runnable: true; row: AdmissionRow }
  | { runnable: false; halted: false }
  | { runnable: false; halted: true; blockedBy: string };

interface AdmissionDbRow {
  id: string;
  session_id: string;
  input: string;
  state: string;
  created_at: string;
  updated_at: string;
  evidence: string | null;
}

function toRow(raw: AdmissionDbRow): AdmissionRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    input: raw.input,
    state: raw.state as AdmissionState,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    evidence: raw.evidence,
  };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`admission: ${name} is required`);
  return value;
}

/**
 * Raised by `admit` when the id already belongs to another session. The caller
 * passed an id that names a different session's accepted input; reporting it as
 * its own admission would alias two sessions' histories, so it is refused with
 * the id and both sessions named.
 */
export class AdmissionIdCollisionError extends Error {
  /** The id both sessions tried to use. */
  readonly id: string;
  /** The session that already owns the row. */
  readonly existingSessionId: string;
  /** The session the refused caller admitted for. */
  readonly sessionId: string;

  constructor(id: string, existingSessionId: string, sessionId: string) {
    super(
      `admission: id ${JSON.stringify(id)} is already admitted in session ${JSON.stringify(existingSessionId)}; ` +
        `it cannot also be this session's input (session ${JSON.stringify(sessionId)})`,
    );
    this.name = "AdmissionIdCollisionError";
    this.id = id;
    this.existingSessionId = existingSessionId;
    this.sessionId = sessionId;
  }
}

/**
 * The admission FIFO over one SessionStore. Construct it with a store —
 * `new AdmissionQueue(store)` — and construct a new one after reopening the
 * store; the rows live in the store's database, not in this object.
 */
export class AdmissionQueue {
  private readonly db: Database;

  constructor(store: SessionStore) {
    this.db = store.db;
  }

  /**
   * Admit one input. Returns the admission id.
   *
   * Dedupe is by id ONLY, and the id is scoped to its session: passing an id
   * already admitted by the SAME session inserts nothing the second time and
   * leaves the existing row (and its state) untouched. An id already admitted
   * by a DIFFERENT session is refused with `AdmissionIdCollisionError` (the id
   * and both sessions are named) — it must never be reported as this caller's
   * admission. A caller that wants a fresh admission passes no id (one is
   * generated) or a new one; the input text is deliberately not an identity.
   */
  admit(sessionId: string, input: string, id: string = newId()): string {
    requireText(sessionId, "sessionId");
    requireText(id, "id");
    if (typeof input !== "string") throw new Error("admission: input must be a string");
    const now = nowIso();
    this.db.run(
      "INSERT OR IGNORE INTO admissions (id, session_id, input, state, created_at, updated_at, evidence) " +
        "VALUES (?, ?, ?, 'queued', ?, ?, NULL)",
      [id, sessionId, input, now, now],
    );
    // Read back the row the insert-or-ignore settled on. A same-session row is
    // the idempotent no-op; a row owned by another session means this id was
    // never admitted for this session, and it is never silently reported as so
    // (this read-back also closes the concurrent double-admit race: whichever
    // insert lost sees the winner's session here).
    const row = this.byId(id);
    if (row && row.sessionId !== sessionId) {
      throw new AdmissionIdCollisionError(id, row.sessionId, sessionId);
    }
    return id;
  }

  /**
   * Move a `queued` row to `running`, but only while it is the row
   * `nextRunnable` would dispatch — a follower behind an `unknown` (or behind an
   * in-flight row) is refused here too, so `begin` cannot be used to bypass a
   * halt. False means nothing was started; it never starts twice.
   */
  begin(id: string): boolean {
    requireText(id, "id");
    const row = this.byId(id);
    if (!row || row.state !== "queued") return false;
    const next = this.nextRunnable(row.sessionId);
    if (!next.runnable || next.row.id !== id) return false;
    const result = this.db.run("UPDATE admissions SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'", [
      nowIso(),
      id,
    ]);
    return result.changes > 0;
  }

  /**
   * Settle a `queued`/`running` row to `done`/`failed`/`unknown`. An already
   * settled row (including `unknown`) is never modified: replaying a terminal
   * state is exactly what the `unknown` rules forbid. When no evidence is given,
   * earlier evidence (e.g. `interrupted`) is kept rather than wiped.
   */
  settle(id: string, state: AdmissionSettlement, evidence?: string): boolean {
    requireText(id, "id");
    if (state !== "done" && state !== "failed" && state !== "unknown") {
      throw new Error(`admission: ${String(state)} is not a settlement state`);
    }
    const result = this.db.run(
      "UPDATE admissions SET state = ?, updated_at = ?, evidence = COALESCE(?, evidence) " +
        "WHERE id = ? AND state IN ('queued','running')",
      [state, nowIso(), evidence ?? null, id],
    );
    return result.changes > 0;
  }

  /** Rows for a session in queue order (insertion order), optionally by state. */
  list(sessionId: string, state?: AdmissionState): AdmissionRow[] {
    requireText(sessionId, "sessionId");
    const rows = state
      ? (this.db
          .query("SELECT id, session_id, input, state, created_at, updated_at, evidence FROM admissions WHERE session_id = ? AND state = ? ORDER BY rowid ASC")
          .all(sessionId, state) as AdmissionDbRow[])
      : (this.db
          .query("SELECT id, session_id, input, state, created_at, updated_at, evidence FROM admissions WHERE session_id = ? ORDER BY rowid ASC")
          .all(sessionId) as AdmissionDbRow[]);
    return rows.map(toRow);
  }

  /**
   * The oldest `queued` row, ONLY IF no earlier row in the queue is `unknown`.
   *
   * A halt is reported with the blocking row's id; an idle queue (nothing
   * queued, no unknown) is `runnable: false, halted: false`; a row behind a
   * `running` row is not offered (work is already reserved). Never replays.
   */
  nextRunnable(sessionId: string): NextRunnable {
    requireText(sessionId, "sessionId");
    let blockedBy: string | undefined;
    let inFlight = false;
    for (const row of this.list(sessionId)) {
      if (row.state === "unknown") {
        blockedBy ??= row.id;
        continue;
      }
      if (row.state === "running") {
        inFlight = true;
        continue;
      }
      if (row.state !== "queued") continue;
      if (blockedBy === undefined && !inFlight) return { runnable: true, row };
    }
    if (blockedBy !== undefined) return { runnable: false, halted: true, blockedBy };
    return { runnable: false, halted: false };
  }

  /**
   * Startup recovery: every `running` row found now was interrupted by the
   * process restart, so it is settled `unknown` with evidence `interrupted` —
   * never retried, never reported as done. Returns the affected ids.
   */
  recoverInterrupted(sessionId: string): string[] {
    requireText(sessionId, "sessionId");
    const ids = (
      this.db.query("SELECT id FROM admissions WHERE session_id = ? AND state = 'running' ORDER BY rowid ASC").all(sessionId) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    if (ids.length > 0) {
      this.db.run(
        "UPDATE admissions SET state = 'unknown', updated_at = ?, " +
          "evidence = CASE WHEN evidence IS NULL OR evidence = '' THEN 'interrupted' ELSE evidence END " +
          "WHERE session_id = ? AND state = 'running'",
        [nowIso(), sessionId],
      );
    }
    return ids;
  }

  /**
   * The explicit human/integrator resolution that unblocks followers.
   *
   *   - `requeue`: an `unknown` row is safe to run again → back to `queued`;
   *   - `drop`:    an `unknown` row is abandoned, never run → `cancelled`;
   *   - `cancel`:  a `queued`/`running`/`unknown` row is withdrawn → `cancelled`.
   *
   * The decision is appended to `evidence` (the recovery trail survives), and
   * the transition is refused — returning undefined — from any other state, so
   * a resolution can never silently re-run a settled row. Returns the updated
   * row, or undefined when nothing changed.
   */
  resolve(id: string, decision: AdmissionResolution): AdmissionRow | undefined {
    requireText(id, "id");
    if (decision !== "requeue" && decision !== "drop" && decision !== "cancel") {
      throw new Error(`admission: ${String(decision)} is not a resolution`);
    }
    const row = this.byId(id);
    if (!row) return undefined;
    let nextState: AdmissionState | undefined;
    if (decision === "requeue") {
      if (row.state === "unknown") nextState = "queued";
    } else if (decision === "drop") {
      if (row.state === "unknown") nextState = "cancelled";
    } else if (row.state === "queued" || row.state === "running" || row.state === "unknown") {
      nextState = "cancelled";
    }
    if (nextState === undefined) return undefined;
    const marker = `resolve:${decision}`;
    this.db.run(
      "UPDATE admissions SET state = ?, updated_at = ?, " +
        "evidence = CASE WHEN evidence IS NULL OR evidence = '' THEN ? ELSE evidence || '; ' || ? END " +
        "WHERE id = ?",
      [nextState, nowIso(), marker, marker, id],
    );
    return this.byId(id) ?? undefined;
  }

  /** Lookup one row by id (null when absent). */
  get(id: string): AdmissionRow | null {
    return this.byId(id);
  }

  private byId(id: string): AdmissionRow | null {
    const raw = this.db
      .query("SELECT id, session_id, input, state, created_at, updated_at, evidence FROM admissions WHERE id = ?")
      .get(id) as AdmissionDbRow | null | undefined;
    return raw ? toRow(raw) : null;
  }
}

/**
 * Refuse loop tool dispatch when the current user-turn admission is not `running`
 * or an earlier `unknown` row still halts the session FIFO (C-13).
 */
export function admissionToolDispatchRefusal(
  queue: AdmissionQueue,
  sessionId: string,
  admissionId: string,
): string | undefined {
  const row = queue.get(admissionId);
  if (!row || row.sessionId !== sessionId) {
    return `HZ_PRECONDITION_FAILED: admission ${admissionId} is missing for this session; tool dispatch halted`;
  }
  if (row.state !== "running") {
    return `HZ_PRECONDITION_FAILED: admission ${admissionId} is ${row.state}; tool dispatch halted`;
  }
  for (const earlier of queue.list(sessionId)) {
    if (earlier.id === admissionId) break;
    if (earlier.state === "unknown") {
      return `HZ_PRECONDITION_FAILED: admission queue halted (blocked by ${earlier.id}); tool dispatch refused`;
    }
  }
  return undefined;
}

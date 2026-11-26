/**
 * steering-drain.ts -- durable per-session steering queue (plan Task 3).
 *
 * The live in-memory InterjectionBuffer remains the turn path; this is the
 * durable backing store a later slice adopts. Draining is one transaction:
 * an abort leaves the queue intact. No new authority, no log events.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { INTERJECTION_LARGE_PROMPT_THRESHOLD } from "./interjection";
import { assertSqliteReconcileBarrierClear } from "./session";

export type SteeringFraming = "steer" | "interrupt";

export interface SteeringDrainRow {
  id: string;
  sessionId: string;
  text: string;
  framing?: SteeringFraming;
  enqueuedAt: string;
}

export function enqueueSteering(
  db: Database,
  sessionId: string,
  text: string,
  framing?: SteeringFraming,
): SteeringDrainRow {
  assertSqliteReconcileBarrierClear("steering-drain.enqueueSteering");
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "") throw new Error("HZ_PRECONDITION_FAILED: steering text must not be blank");
  if (framing !== undefined && framing !== "steer" && framing !== "interrupt") {
    throw new Error(`HZ_PRECONDITION_FAILED: unknown steering framing ${String(framing)}`);
  }
  const row: SteeringDrainRow = {
    id: randomUUID(),
    sessionId,
    text: value.length > INTERJECTION_LARGE_PROMPT_THRESHOLD
      ? `${value.slice(0, INTERJECTION_LARGE_PROMPT_THRESHOLD)}... [truncated]`
      : value,
    ...(framing === undefined ? {} : { framing }),
    enqueuedAt: new Date().toISOString(),
  };
  db.query(
    "INSERT INTO steering_drain (id, session_id, text, framing, enqueued_at) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, row.sessionId, row.text, row.framing ?? null, row.enqueuedAt);
  return row;
}

/** FIFO drain; selected rows are deleted in the SAME transaction. */
export function drainSteering(db: Database, sessionId: string): SteeringDrainRow[] {
  assertSqliteReconcileBarrierClear("steering-drain.drainSteering");
  const run = db.transaction(() => {
    const rows = db.query(
      "SELECT id, session_id, text, framing, enqueued_at FROM steering_drain WHERE session_id = ? ORDER BY enqueued_at, rowid",
    ).all(sessionId) as Array<{
      id: string;
      session_id: string;
      text: string;
      framing: string | null;
      enqueued_at: string;
    }>;
    if (rows.length === 0) return [];
    const remove = db.query("DELETE FROM steering_drain WHERE id = ?");
    for (const row of rows) remove.run(row.id);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      text: row.text,
      ...(row.framing === null ? {} : { framing: row.framing as SteeringFraming }),
      enqueuedAt: row.enqueued_at,
    }));
  });
  return run();
}

export function pendingSteeringCount(db: Database, sessionId: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM steering_drain WHERE session_id = ?").get(sessionId) as { n: number } | null;
  return Number(row?.n ?? 0);
}

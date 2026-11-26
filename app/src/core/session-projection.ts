/**
 * session-projection.ts -- minimal lifecycle projection with atomic watermark
 * (plan Task 16). Projection is derived; `session_event` remains the truth.
 */

import type { Database } from "bun:sqlite";
import { sha256Hex } from "./canon";
import { assertSqliteReconcileBarrierClear } from "./session";
import { readSessionEvents } from "./session-event-store";

export interface ProjectorManifest {
  name: string;
  consumedTypes: readonly string[];
  ownedTable: string;
}

export const SESSION_LIFECYCLE_PROJECTOR: ProjectorManifest = {
  name: "session.lifecycle",
  consumedTypes: ["session.start", "session.end"],
  ownedTable: "session_lifecycle",
};

export interface SessionLifecycleView {
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
}

export function sessionLifecycle(db: Database, aggregateId: string): SessionLifecycleView {
  const row = db.query(
    "SELECT started_at, ended_at, event_count FROM session_lifecycle WHERE aggregate_id = ?",
  ).get(aggregateId) as { started_at: string | null; ended_at: string | null; event_count: number } | null;
  return {
    startedAt: row?.started_at ?? null,
    endedAt: row?.ended_at ?? null,
    eventCount: row?.event_count ?? 0,
  };
}

export function foldSessionEvents(
  db: Database,
  aggregateId: string,
  manifest: ProjectorManifest = SESSION_LIFECYCLE_PROJECTOR,
): { applied: number; throughSeq: number } {
  assertSqliteReconcileBarrierClear("session-projection.foldSessionEvents");
  const stored = db.query(
    "SELECT applied_through_seq FROM projection_watermark WHERE projector=? AND aggregate_id=?",
  ).get(manifest.name, aggregateId) as { applied_through_seq: number } | null;
  const through = stored?.applied_through_seq ?? 0;
  const rows = readSessionEvents(db, aggregateId, through + 1);
  if (rows.length === 0) return { applied: 0, throughSeq: through };
  const consumed = rows.filter((row) => manifest.consumedTypes.includes(row.type));
  const lastSeq = rows[rows.length - 1]!.seq;

  const run = db.transaction(() => {
    const lifecycle = sessionLifecycle(db, aggregateId);
    let startedAt = lifecycle.startedAt;
    let endedAt = lifecycle.endedAt;
    for (const row of consumed) {
      const at = typeof row.payload.at === "string" ? row.payload.at : row.ts;
      if (row.type === "session.start" && startedAt === null) startedAt = at;
      if (row.type === "session.end") endedAt = at;
    }
    db.query(
      `INSERT INTO session_lifecycle (aggregate_id, started_at, ended_at, event_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(aggregate_id) DO UPDATE SET
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         event_count = excluded.event_count`,
    ).run(aggregateId, startedAt, endedAt, lifecycle.eventCount + consumed.length);
    const digest = sha256Hex(rows.map((row) => `${row.seq}:${row.digest}`).join("\n"));
    db.query(
      `INSERT INTO projection_watermark (projector, aggregate_id, applied_through_seq, digest)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(projector, aggregate_id) DO UPDATE SET
         applied_through_seq = excluded.applied_through_seq,
         digest = excluded.digest`,
    ).run(manifest.name, aggregateId, Math.max(through, lastSeq), digest);
  });
  run();
  return { applied: consumed.length, throughSeq: Math.max(through, lastSeq) };
}

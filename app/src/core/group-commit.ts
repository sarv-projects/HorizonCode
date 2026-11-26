/**
 * group-commit.ts — durable group-commit store (Group H, port of pi-durable /
 * chord group commit). Source pattern: repo_take/pi/packages/chord/src/store.
 *
 * N task events are appended to `session_event` in ONE SQLite transaction with
 * a group digest over the ordered seq:digest list; a repeated group id is
 * idempotent (no duplicate events, same digest). Uses the existing typed event
 * store so the hash chain and projection fold stay intact. No contract change.
 */

import type { Database } from "bun:sqlite";
import { sha256Hex } from "./canon";
import { assertSqliteReconcileBarrierClear } from "./session";
import {
  appendSessionEvent,
  readSessionEvents,
  type SessionEventSeed,
} from "./session-event-store";

export interface TaskGroupSeed {
  groupId: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface GroupCommitResult {
  committed: number;
  groupDigest: string;
  alreadyCommitted: boolean;
}

export interface TaskGroupRecord {
  groupId: string;
  aggregateId: string;
  groupDigest: string;
  eventCount: number;
}

export function readTaskGroup(db: Database, groupId: string): TaskGroupRecord | undefined {
  const row = db
    .query("SELECT group_id, aggregate_id, group_digest, event_count FROM task_group WHERE group_id = ?")
    .get(groupId) as {
    group_id: string;
    aggregate_id: string;
    group_digest: string;
    event_count: number;
  } | null;
  if (row === null) return undefined;
  return {
    groupId: row.group_id,
    aggregateId: row.aggregate_id,
    groupDigest: row.group_digest,
    eventCount: row.event_count,
  };
}

export function commitTaskGroup(
  db: Database,
  aggregateId: string,
  seeds: readonly TaskGroupSeed[],
): GroupCommitResult {
  assertSqliteReconcileBarrierClear("group-commit.commitTaskGroup");
  if (seeds.length === 0) throw new Error("HZ_PRECONDITION_FAILED: empty task group");
  const groupId = seeds[0]!.groupId;
  if (seeds.some((s) => s.groupId !== groupId)) {
    throw new Error("HZ_PRECONDITION_FAILED: all seeds must share one group id");
  }
  const existing = readTaskGroup(db, groupId);
  if (existing !== undefined) {
    return {
      committed: 0,
      groupDigest: existing.groupDigest,
      alreadyCommitted: true,
    };
  }

  const run = db.transaction(() => {
    const before = readSessionEvents(db, aggregateId).length;
    const seedsToAppend: SessionEventSeed[] = seeds.map((seed) => ({
      aggregateId,
      type: seed.type,
      actorKind: "system",
      actorId: `group:${groupId}`,
      payload: {
        ...(seed.payload ?? {}),
        groupId,
      },
    }));
    for (const seed of seedsToAppend) appendSessionEvent(db, seed);
    const rows = readSessionEvents(db, aggregateId).slice(before);
    const groupDigest = sha256Hex(rows.map((r) => `${r.seq}:${r.digest}`).join("\n"));
    db.query(
      `INSERT INTO task_group (group_id, aggregate_id, group_digest, event_count, committed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(groupId, aggregateId, groupDigest, rows.length, new Date().toISOString());
    return { committed: rows.length, groupDigest, alreadyCommitted: false };
  });
  return run();
}

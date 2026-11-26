/**
 * session-event-store.ts -- typed append/read + chain verification (plan Task 15).
 *
 * Parallel typed store over the migration-4 `session_event` table. The Rust
 * kernel event log remains authoritative; this module adds no authority and no
 * new contract fields.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ActorKind } from "../contracts";
import { canonicalJson, sha256Hex } from "./canon";
import { assertSqliteReconcileBarrierClear } from "./session";

export interface SessionEventSeed {
  aggregateId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export interface SessionEventRow extends SessionEventSeed {
  id: string;
  seq: number;
  ts: string;
  prevDigest: string | null;
  digest: string;
}

function digestPreimage(row: Omit<SessionEventRow, "digest">): string {
  return canonicalJson({
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    aggregateId: row.aggregateId,
    type: row.type,
    actorKind: row.actorKind,
    actorId: row.actorId,
    payload: row.payload,
    prevDigest: row.prevDigest,
  });
}

export function appendSessionEvent(db: Database, seed: SessionEventSeed): SessionEventRow {
  assertSqliteReconcileBarrierClear("session-event-store.appendSessionEvent");
  if (seed.aggregateId.trim() === "" || seed.type.trim() === "" || seed.actorId.trim() === "") {
    throw new Error("HZ_PRECONDITION_FAILED: session event requires aggregateId, type and actorId");
  }
  const run = db.transaction(() => {
    const row = db.query("SELECT MAX(seq) AS n FROM session_event WHERE aggregate_id = ?").get(seed.aggregateId) as { n: number | null } | null;
    const seq = (row?.n ?? 0) + 1;
    const prevRow = db.query("SELECT digest FROM session_event WHERE aggregate_id = ? AND seq = ?").get(seed.aggregateId, seq - 1) as { digest: string } | null;
    const prevDigest = prevRow?.digest ?? null;
    const entry: Omit<SessionEventRow, "digest"> = {
      ...seed,
      id: randomUUID(),
      seq,
      ts: seed.ts ?? new Date().toISOString(),
      prevDigest,
    };
    const digest = sha256Hex(digestPreimage(entry));
    db.query(
      `INSERT INTO session_event
        (id, aggregate_id, seq, ts, type, actor_kind, actor_id, payload, prev_digest, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.aggregateId,
      entry.seq,
      entry.ts,
      entry.type,
      entry.actorKind,
      entry.actorId,
      canonicalJson(entry.payload),
      entry.prevDigest,
      digest,
    );
    return { ...entry, digest };
  });
  return run();
}

interface StoredRow {
  id: string;
  aggregate_id: string;
  seq: number;
  ts: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload: string;
  prev_digest: string | null;
  digest: string;
}

function fromStored(stored: StoredRow): SessionEventRow {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stored.payload) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`HZ_PRECONDITION_FAILED: session_event ${stored.id} payload is not valid JSON`);
  }
  return {
    id: stored.id,
    aggregateId: stored.aggregate_id,
    seq: stored.seq,
    ts: stored.ts,
    type: stored.type,
    actorKind: stored.actor_kind as ActorKind,
    actorId: stored.actor_id,
    payload,
    prevDigest: stored.prev_digest,
    digest: stored.digest,
  };
}

export function readSessionEvents(db: Database, aggregateId: string, fromSeq = 0): SessionEventRow[] {
  const rows = db.query(
    `SELECT id, aggregate_id, seq, ts, type, actor_kind, actor_id, payload, prev_digest, digest
     FROM session_event WHERE aggregate_id = ? AND seq >= ? ORDER BY seq`,
  ).all(aggregateId, fromSeq) as StoredRow[];
  return rows.map(fromStored);
}

export function verifySessionEventChain(rows: readonly SessionEventRow[]): { ok: boolean; brokenAt?: number } {
  let previousDigest: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.prevDigest !== previousDigest) return { ok: false, brokenAt: i + 1 };
    const computed = sha256Hex(digestPreimage(row));
    if (computed !== row.digest) return { ok: false, brokenAt: i + 1 };
    previousDigest = row.digest;
  }
  return { ok: true };
}

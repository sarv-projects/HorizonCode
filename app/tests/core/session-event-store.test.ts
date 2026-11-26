/**
 * session-event-store.test.ts -- typed append/read + chain verification
 * (plan Task 15). Parallel typed store; kernel event log stays authoritative.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { migrateSessionDb } from "../../src/core/session-migrate";
import {
  appendSessionEvent,
  readSessionEvents,
  verifySessionEventChain,
} from "../../src/core/session-event-store";

function openMigratedDb(): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-session-events-"));
  const db = new Database(path.join(dir, "session.db"), { create: true });
  migrateSessionDb(db);
  return { db, cleanup: () => { try { db.close(); } catch { /* closed */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } } };
}

const seed = (type: string, payload: Record<string, unknown> = {}) => ({
  aggregateId: "s1",
  type,
  actorKind: "system" as const,
  actorId: "boot",
  payload,
});

describe("typed session event store", () => {
  test("events are sequenced per aggregate with a hash-linked chain", () => {
    const { db, cleanup } = openMigratedDb();
    try {
      const a = appendSessionEvent(db, seed("session.start"));
      const b = appendSessionEvent(db, seed("session.end"));
      expect([a.seq, b.seq]).toEqual([1, 2]);
      expect(b.prevDigest).toBe(a.digest);
      const rows = readSessionEvents(db, "s1");
      expect(verifySessionEventChain(rows).ok).toBe(true);
      rows[0]!.payload = { tampered: true } as never;
      expect(verifySessionEventChain(rows).brokenAt).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("aggregates are isolated and unknown aggregates return no rows", () => {
    const { db, cleanup } = openMigratedDb();
    try {
      appendSessionEvent(db, seed("session.start"));
      appendSessionEvent(db, { ...seed("session.start"), aggregateId: "s2" });
      expect(readSessionEvents(db, "s1").map((r) => r.seq)).toEqual([1]);
      expect(readSessionEvents(db, "nope")).toEqual([]);
      expect(readSessionEvents(db, "s1", 2)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("invalid stored JSON payload is a named refusal", () => {
    const { db, cleanup } = openMigratedDb();
    try {
      const row = appendSessionEvent(db, seed("session.start"));
      db.query("UPDATE session_event SET payload = ? WHERE id = ?").run("{bad json", row.id);
      expect(() => readSessionEvents(db, "s1")).toThrow(/payload/i);
    } finally {
      cleanup();
    }
  });
});

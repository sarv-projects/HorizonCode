/**
 * session-projection.test.ts -- minimal lifecycle projection with atomic
 * watermark (plan Task 16). The log remains the truth; projection is derived.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { migrateSessionDb } from "../../src/core/session-migrate";
import { appendSessionEvent } from "../../src/core/session-event-store";
import {
  foldSessionEvents,
  SESSION_LIFECYCLE_PROJECTOR,
  sessionLifecycle,
} from "../../src/core/session-projection";

function openWithEvents() {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-session-proj-"));
  const db = new Database(path.join(dir, "session.db"), { create: true });
  migrateSessionDb(db);
  const append = (type: string, payload: Record<string, unknown>) =>
    appendSessionEvent(db, {
      aggregateId: "s1",
      type,
      actorKind: "system",
      actorId: "boot",
      payload,
    });
  const cleanup = () => {
    try { db.close(); } catch { /* closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  };
  return { db, append, cleanup };
}

describe("minimal session projection", () => {
  test("fold is atomic, idempotent and catches a later event", () => {
    const { db, append, cleanup } = openWithEvents();
    try {
      append("session.start", { at: "2026-11-21T00:00:00.000Z" });
      expect(foldSessionEvents(db, "s1")).toEqual({ applied: 1, throughSeq: 1 });
      expect(foldSessionEvents(db, "s1")).toEqual({ applied: 0, throughSeq: 1 });
      append("session.end", { at: "2026-11-21T01:00:00.000Z" });
      expect(foldSessionEvents(db, "s1")).toEqual({ applied: 1, throughSeq: 2 });
      expect(sessionLifecycle(db, "s1").endedAt).toBe("2026-11-21T01:00:00.000Z");
      expect(
        db.query("SELECT applied_through_seq FROM projection_watermark WHERE projector=? AND aggregate_id=?")
          .get(SESSION_LIFECYCLE_PROJECTOR.name, "s1"),
      ).toMatchObject({ applied_through_seq: 2 });
    } finally {
      cleanup();
    }
  });

  test("unknown event types are ignored and unknown aggregates are empty", () => {
    const { db, append, cleanup } = openWithEvents();
    try {
      append("hz.unrelated.event", {});
      expect(foldSessionEvents(db, "s1")).toEqual({ applied: 0, throughSeq: 1 });
      expect(foldSessionEvents(db, "missing")).toEqual({ applied: 0, throughSeq: 0 });
      expect(sessionLifecycle(db, "missing").eventCount).toBe(0);
    } finally {
      cleanup();
    }
  });
});

/**
 * session-event-migration.test.ts -- typed event + lifecycle tables
 * (plan Task 14; migration 4 in this tree because ruling 781 used slot 3).
 * Tables only; no backfill, no claim of event sourcing yet.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  migrateSessionDb,
  readSessionDbUserVersion,
  SESSION_DB_USER_VERSION,
} from "../../src/core/session-migrate";

describe("session event migration", () => {
  test("creates typed event + lifecycle tables idempotently", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-session-event-mig-"));
    try {
      const db = new Database(path.join(dir, "session.db"), { create: true });
      migrateSessionDb(db);
      expect(readSessionDbUserVersion(db)).toBe(5);
      expect(SESSION_DB_USER_VERSION).toBe(5);
      for (const table of ["session_event", "session_lifecycle", "projection_watermark", "steering_drain", "task_group"]) {
        expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toMatchObject({ name: table });
      }
      const columns = db.query("PRAGMA table_info(session_event)").all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining([
        "aggregate_id", "seq", "ts", "type", "actor_kind", "actor_id", "payload", "digest",
      ]));
      migrateSessionDb(db);
      expect(readSessionDbUserVersion(db)).toBe(5);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may keep the SQLite handle briefly; cleanup is not an assertion. */
      }
    }
  });
});

/**
 * steering-drain.test.ts -- durable steering queue (plan Task 3).
 * File-backed SQLite store; deliberately not wired into the live turn path yet.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { migrateSessionDb, SESSION_DB_USER_VERSION } from "../../src/core/session-migrate";
import {
  drainSteering,
  enqueueSteering,
  pendingSteeringCount,
} from "../../src/core/steering-drain";

function tempDbPath(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-steering-drain-"));
  return { file: path.join(dir, "session.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("durable steering drain", () => {
  test("survives reopen and drains FIFO exactly once", () => {
    const { file, cleanup } = tempDbPath();
    try {
      const db = new Database(file, { create: true });
      migrateSessionDb(db);
      expect(SESSION_DB_USER_VERSION).toBeGreaterThanOrEqual(3);
      enqueueSteering(db, "s1", "first", "steer");
      enqueueSteering(db, "s1", "second", "interrupt");
      expect(pendingSteeringCount(db, "s1")).toBe(2);
      db.close();

      const reopened = new Database(file, { create: true });
      migrateSessionDb(reopened);
      expect(drainSteering(reopened, "s1").map((r) => r.text)).toEqual(["first", "second"]);
      expect(drainSteering(reopened, "s1")).toEqual([]);
      expect(pendingSteeringCount(reopened, "s1")).toBe(0);
      reopened.close();
    } finally {
      cleanup();
    }
  });

  test("rejects blank text and unknown framing without enqueuing", () => {
    const { file, cleanup } = tempDbPath();
    try {
      const db = new Database(file, { create: true });
      migrateSessionDb(db);
      expect(() => enqueueSteering(db, "s1", "  ")).toThrow(/blank/i);
      expect(() => enqueueSteering(db, "s1", "x", "bogus" as never)).toThrow(/framing/i);
      expect(pendingSteeringCount(db, "s1")).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });
});

/**
 * group-commit.test.ts — Group H durable group-commit store (chord/pi-durable port).
 * N events appended in ONE transaction with a group digest; repeated group id is idempotent.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { migrateSessionDb } from "../../src/core/session-migrate";
import { readSessionEvents } from "../../src/core/session-event-store";
import {
  commitTaskGroup,
  readTaskGroup,
  type TaskGroupSeed,
} from "../../src/core/group-commit";

function db() {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-group-commit-"));
  const database = new Database(path.join(dir, "session.db"), { create: true });
  migrateSessionDb(database);
  return { database, cleanup: () => { try { database.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const SEEDS: TaskGroupSeed[] = [
  { groupId: "g1", type: "task.start", payload: { task: "a" } },
  { groupId: "g1", type: "task.done", payload: { task: "a" } },
];

describe("atomic task group commit (chord port)", () => {
  test("commits N events in one group with a digest; all are readable in order", () => {
    const { database, cleanup } = db();
    try {
      const result = commitTaskGroup(database, "s1", SEEDS);
      expect(result.committed).toBe(2);
      expect(result.groupDigest).toMatch(/^[0-9a-f]{64}$/);
      const rows = readSessionEvents(database, "s1");
      expect(rows.map((r) => r.type)).toEqual(["task.start", "task.done"]);
      expect(rows.map((r) => r.seq)).toEqual([1, 2]);
      expect(readTaskGroup(database, "g1")?.groupDigest).toBe(result.groupDigest);
    } finally {
      cleanup();
    }
  });

  test("repeated group id is idempotent: no duplicate events, same digest", () => {
    const { database, cleanup } = db();
    try {
      const first = commitTaskGroup(database, "s1", SEEDS);
      const second = commitTaskGroup(database, "s1", SEEDS);
      expect(second.committed).toBe(0);
      expect(second.groupDigest).toBe(first.groupDigest);
      expect(readSessionEvents(database, "s1")).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("an empty group is refused without writing anything", () => {
    const { database, cleanup } = db();
    try {
      expect(() => commitTaskGroup(database, "s1", [])).toThrow(/empty/i);
      expect(readSessionEvents(database, "s1")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

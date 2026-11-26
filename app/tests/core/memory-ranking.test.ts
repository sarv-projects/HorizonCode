/**
 * memory-ranking.test.ts -- opt-in additive ranking fusion (plan Task 24).
 * Default memorySearchHits stays byte-identical; rank:true layers RRF/decay/
 * supersession without embeddings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/core/canon";
import {
  memoryDbPath,
  memorySearchRanked,
  rememberMemoryFact,
  replaceMemoryIndex,
} from "../../src/core/memory/store";

let workspace = "";
afterEach(() => {
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* Windows lock */
    }
  }
  workspace = "";
});

const NOW = Date.parse("2026-11-21T00:00:00Z");
const DAY = 86_400_000;

describe("additive memory ranking", () => {
  test("rank:false delegates to plain search; rank:true returns valid hits", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memrank-"));
    replaceMemoryIndex(workspace, ["db: host is a", "editor: vim"]);
    const plain = memorySearchRanked(workspace, "db host", { rank: false });
    expect(plain.map((h) => h.content)).toEqual(["db: host is a"]);
    const ranked = memorySearchRanked(workspace, "db host", { rank: true, nowMs: NOW });
    expect(ranked.every((h) => typeof h.content === "string")).toBe(true);
    expect(ranked.length).toBeLessThanOrEqual(plain.length);
  });

  test("storedAt override lets the newest fact supersede an older same-key fact", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memrank-sup-"));
    replaceMemoryIndex(workspace, ["db: host is a", "db: host is b"]);
    const plain = memorySearchRanked(workspace, "db", { rank: false });
    expect(plain.length).toBe(2);
    const ranked = memorySearchRanked(workspace, "db", {
      rank: true,
      nowMs: NOW,
      storedAt: new Map([
        ["db: host is a", NOW - 2 * DAY],
        ["db: host is b", NOW],
      ]),
    });
    expect(ranked.map((h) => h.content)).toEqual(["db: host is b"]);
  });

  test("rememberMemoryFact records a meta row used by ranked decay", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memrank-meta-"));
    const result = rememberMemoryFact(workspace, "editor: nano");
    expect(result.ok).toBe(true);
    const db = new Database(memoryDbPath(workspace));
    try {
      const row = db
        .query("SELECT stored_at FROM memory_fact_meta WHERE content_sha256 = ?")
        .get(sha256Hex("editor: nano")) as { stored_at: string } | null;
      expect(row).not.toBeNull();
      expect(Number.isNaN(Date.parse(row!.stored_at))).toBe(false);
    } finally {
      db.close();
    }
    const ranked = memorySearchRanked(workspace, "editor nano", { rank: true, nowMs: NOW + DAY });
    expect(ranked.map((h) => h.content)).toContain("editor: nano");
  });
});

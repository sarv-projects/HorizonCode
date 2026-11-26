/**
 * memory-supersession.test.ts -- lexical fact supersession overlay (plan Task 23).
 * Ranking overlay only: no deletion, no embeddings, no fuzzy/semantic matching.
 */
import { describe, expect, test } from "bun:test";
import { applySupersession, factKey, type MemoryFactRow } from "../../src/core/memory/supersession";

describe("lexical fact supersession", () => {
  test("a newer fact with the same key supersedes the older one", () => {
    const rows: MemoryFactRow[] = [
      { id: "old", content: "db: host is a", storedAtMs: 100 },
      { id: "new", content: "db: host is b", storedAtMs: 200 },
      { id: "other", content: "editor: vim", storedAtMs: 50 },
    ];
    expect(factKey(rows[0]!.content)).toBe(factKey(rows[1]!.content));
    expect(factKey(rows[2]!.content)).not.toBe(factKey(rows[0]!.content));
    const out = applySupersession(rows);
    expect(out.active.map((r) => r.id)).toEqual(["new", "other"]);
    expect(out.supersededIds).toEqual(["old"]);
  });

  test("factKey lowercases, trims and normalizes whitespace before the first colon", () => {
    expect(factKey("  DB : host is a")).toBe(factKey("db:host"));
    expect(factKey("no colon here")).toBe("no colon here");
    expect(factKey("  spaced   words  ")).toBe("spaced words");
  });

  test("most-recent wins with stable id tie-break; input order preserved among active", () => {
    const rows: MemoryFactRow[] = [
      { id: "z-old", content: "k: a", storedAtMs: 100 },
      { id: "first", content: "other: x", storedAtMs: 500 },
      { id: "a-old", content: "k: b", storedAtMs: 100 },
      { id: "new", content: "k: c", storedAtMs: 200 },
    ];
    const out = applySupersession(rows);
    expect(out.active.map((r) => r.id)).toEqual(["first", "new"]);
    expect(out.supersededIds.sort()).toEqual(["a-old", "z-old"]);
  });

  test("no mutation and no store deletion: superseded rows are returned, not removed", () => {
    const rows: MemoryFactRow[] = [
      { id: "old", content: "k: a", storedAtMs: 1 },
      { id: "new", content: "k: b", storedAtMs: 2 },
    ];
    const snapshot = rows.map((r) => ({ ...r }));
    const out = applySupersession(rows);
    expect(rows).toEqual(snapshot);
    expect(out.active).toHaveLength(1);
    expect(out.supersededIds).toEqual(["old"]);
  });
});

/**
 * memory-rrf.test.ts -- reciprocal rank fusion k=60 (plan Task 21).
 * Pure lexical scorer: no embeddings, no semantic dedup, no vector store.
 */
import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion, RRF_K } from "../../src/core/memory/rrf";

describe("reciprocal rank fusion", () => {
  test("sums 1/(k+rank) with a deterministic lexical tie-break", () => {
    expect(RRF_K).toBe(60);
    const out = reciprocalRankFusion([["a", "b"], ["b", "a"]]);
    // Both ids are rank 1 once and rank 2 once, so scores tie and lexical
    // order decides: a before b.
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out[0]!.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2));
    // A single ranking is not a tie: rank 1 outranks rank 2.
    const ranked = reciprocalRankFusion([["z", "a"]]);
    expect(ranked.map((x) => x.id)).toEqual(["z", "a"]);
    // A genuine tie breaks lexically.
    const tie = reciprocalRankFusion([["z", "a"], ["a", "z"]]);
    expect(tie.map((x) => x.id)).toEqual(["a", "z"]);
  });

  test("duplicate ids in one ranking count once; custom k is supported", () => {
    const out = reciprocalRankFusion([["a", "a", "b"]], 10);
    expect(out).toEqual([
      { id: "a", score: 1 / 11 },
      { id: "b", score: 1 / 13 }, // rank is the list position, duplicates ignored only for counting
    ]);
  });

  test("empty and invalid inputs never fabricate rows", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
    expect(reciprocalRankFusion([["a"]], 0)).toEqual([{ id: "a", score: 1 }]);
  });
});

import { describe, expect, test } from "bun:test";
import { mmrLiteSelect } from "../../src/core/memory/mmr-lite";

describe("mmr-lite", () => {
  test("prefers diverse hits when BM25 top rows are near-duplicates", () => {
    const candidates = [
      { content: "deploy staging on Friday afternoon", rank: -3.2 },
      { content: "deploy staging on Friday evening", rank: -3.0 },
      { content: "prefer ripgrep over grep for search", rank: -2.4 },
    ];
    const picked = mmrLiteSelect(candidates, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0].content).toContain("deploy staging");
    expect(picked.some((p) => p.content.includes("ripgrep"))).toBe(true);
  });

  test("returns all when under limit", () => {
    const one = [{ content: "solo fact", rank: -1 }];
    expect(mmrLiteSelect(one, 3)).toEqual(one);
  });
});

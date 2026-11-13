import { describe, expect, test } from "bun:test";
import { fuzzyScore } from "../../src/tui/fuzzy";

describe("fuzzy", () => {
  test("prefix scores higher than subsequence", () => {
    const a = fuzzyScore("ses", "sessions list");
    const b = fuzzyScore("ses", "posix-assess");
    expect(a).toBeGreaterThan(b);
  });

  test("no match is -1", () => {
    expect(fuzzyScore("zzz", "help")).toBe(-1);
  });
});

import { describe, expect, test } from "bun:test";
import { foldMiddleLines, isFoldedMiddleMarker } from "../../src/tui/fold-lines";

describe("fold-lines", () => {
  test("folds a long run", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    expect(foldMiddleLines(lines, { first: 2, last: 2, ellipsis: "..." })).toEqual(["a", "b", "... +3 lines", "f", "g"]);
  });

  test("short run unchanged", () => {
    const lines = ["a", "b", "c", "d"];
    expect(foldMiddleLines(lines, { first: 2, last: 2 })).toEqual(lines);
  });

  test("marker detector", () => {
    expect(isFoldedMiddleMarker("... +3 lines")).toBe(true);
    expect(isFoldedMiddleMarker("hello")).toBe(false);
  });
});

/**
 * hunk-review.test.ts -- per-hunk review model for Plan Mode (docs/28 §14).
 * Pure parsing/decision model; no TTY, no filesystem, no runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  applyHunkDecisions,
  nextHunkCursor,
  parseDiffHunks,
  renderHunkReview,
  type HunkReviewDecision,
} from "../../src/tui/hunk-review";

const DIFF = [
  "@@ -1,3 +1,3 @@",
  " context before",
  "-old line",
  "+new line",
  "@@ -10,2 +10,2 @@",
  "-second old",
  "+second new",
].join("\n");

describe("diff hunk parsing", () => {
  test("splits unified diff into indexed hunks with their lines", () => {
    const hunks = parseDiffHunks(DIFF, "src/a.ts");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.index).toBe(1);
    expect(hunks[0]!.path).toBe("src/a.ts");
    expect(hunks[0]!.header).toContain("-1,3 +1,3");
    expect(hunks[0]!.lines.join("\n")).toContain("-old line");
    expect(hunks[1]!.lines.join("\n")).toContain("+second new");
  });

  test("empty or headerless diffs produce no hunks", () => {
    expect(parseDiffHunks("", "a.ts")).toEqual([]);
    expect(parseDiffHunks("-old\n+new\n", "a.ts")).toEqual([]);
  });
});

describe("review decisions", () => {
  test("accept/reject/edit produce a compact apply selection", () => {
    const hunks = parseDiffHunks(DIFF, "src/a.ts");
    hunks[0]!.decision = "accept" as HunkReviewDecision;
    hunks[1]!.decision = "reject" as HunkReviewDecision;
    const result = applyHunkDecisions(hunks);
    expect(result.accepted).toEqual([1]);
    expect(result.rejected).toEqual([2]);
    expect(result.selection).toBe("src/a.ts:1");
    expect(result.pending).toBe(0);

    hunks[1]!.decision = "accept";
    expect(applyHunkDecisions(hunks).selection).toBe("src/a.ts:1,2");
  });

  test("edit decisions stay pending and are never silently applied", () => {
    const hunks = parseDiffHunks(DIFF, "src/a.ts");
    hunks[0]!.decision = "edit";
    const result = applyHunkDecisions(hunks);
    // The edit hunk and the still-undecided hunk are both pending.
    expect(result.pending).toBe(2);
    expect(result.selection).toBe("");
  });
});

describe("review rendering and cursor", () => {
  test("renders per-hunk markers and wraps the cursor", () => {
    const hunks = parseDiffHunks(DIFF, "src/a.ts");
    const text = renderHunkReview(hunks, 0);
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(text).toContain("❯");
    expect(nextHunkCursor(hunks, "down", 0)).toBe(1);
    expect(nextHunkCursor(hunks, "down", 1)).toBe(0);
    expect(nextHunkCursor(hunks, "up", 0)).toBe(1);
    expect(nextHunkCursor([], "down", 0)).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  applyHunkSelections,
  labelDiffHunkHeaders,
  parseHunkApplySelection,
  partialAfterFromHunks,
  stageWrite,
  stagedChanges,
} from "../../src/core/plan";

describe("plan hunks", () => {
  test("labels @@ headers with optional file", () => {
    const diff = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n";
    expect(labelDiffHunkHeaders(diff)).toContain("[hunk 1] @@");
    expect(labelDiffHunkHeaders(diff, "src/a.ts")).toContain("[hunk 1 · src/a.ts] @@");
  });

  test("partial apply keeps unselected hunk", () => {
    const same = Array(20).fill("same");
    const before = ["h1", ...same, "h2"].join("\n") + "\n";
    const after = ["H1", ...same, "H2"].join("\n") + "\n";
    const patched = partialAfterFromHunks(before, after, [1]);
    expect(patched).toContain("H1");
    expect(patched).toContain("h2");
    expect(patched).not.toContain("H2");
  });

  test("parseHunkApplySelection", () => {
    expect(parseHunkApplySelection("")).toBe(null);
    expect(parseHunkApplySelection("1, 3")).toEqual({ hunks: [1, 3] });
    expect(parseHunkApplySelection("a.ts:1,2 b.ts:3")).toEqual({
      files: [
        { rel: "a.ts", hunks: [1, 2] },
        { rel: "b.ts", hunks: [3] },
      ],
    });
    expect(parseHunkApplySelection("nope")).toBe(undefined);
  });

  test("multi-file hunk apply updates each staged path", () => {
    const sid = "hunk-multi";
    stageWrite(sid, {
      resolved: "/w/a.ts",
      rel: "a.ts",
      before: "a\n",
      after: "A\n",
      tool: "edit",
    });
    stageWrite(sid, {
      resolved: "/w/b.ts",
      rel: "b.ts",
      before: "b\n",
      after: "B\n",
      tool: "edit",
    });
    const staged = stagedChanges(sid);
    const pick = parseHunkApplySelection("a.ts:1 b.ts:1");
    expect(pick).toEqual({ files: [{ rel: "a.ts", hunks: [1] }, { rel: "b.ts", hunks: [1] }] });
    const result = applyHunkSelections(sid, staged, pick as NonNullable<typeof pick>);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.updated).toEqual(["a.ts", "b.ts"]);
    expect(stagedChanges(sid)[0]?.after).toBe("A\n");
    expect(stagedChanges(sid)[1]?.after).toBe("B\n");
  });

  test("bare indices refuse when multiple files are staged", () => {
    const sid = "hunk-refuse";
    stageWrite(sid, { resolved: "/w/1", rel: "1", before: "x", after: "X", tool: "write" });
    stageWrite(sid, { resolved: "/w/2", rel: "2", before: "y", after: "Y", tool: "write" });
    const pick = parseHunkApplySelection("1");
    const result = applyHunkSelections(sid, stagedChanges(sid), pick as NonNullable<typeof pick>);
    expect(result.ok).toBe(false);
  });
});

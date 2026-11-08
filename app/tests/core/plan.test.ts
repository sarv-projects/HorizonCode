/**
 * plan.test.ts — the plan-mode staging store and its review diff.
 *
 * The store is bounded and session-scoped; the diff is the evidence the human
 * reviews before /apply, so both are pinned here: what is staged (and what an
 * eviction drops), what a discard and a take leave behind, and the exact bytes
 * of a unified diff (context, headers, truncation marker, byte stability).
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_STAGED_BYTES,
  MAX_STAGED_CHANGES,
  discardStaged,
  planSize,
  stageWrite,
  stagedChanges,
  takeStaged,
  unifiedDiff,
  type StagedChange,
} from "../../src/core/plan";

function change(rel: string, after: string, before: string | null = null): StagedChange {
  return { resolved: `/ws/${rel}`, rel, before, after, tool: before === null ? "write" : "edit" };
}

const SESSION = "plan-test-session";

describe("the staged-change store", () => {
  test("stages changes in order and reports the size", () => {
    const sid = `${SESSION}-stage`;
    const first = stageWrite(sid, change("a.txt", "one\n"));
    const second = stageWrite(sid, change("b.txt", "two\n", "before\n"));

    expect(first).toEqual({ staged: true, evicted: 0 });
    expect(second).toEqual({ staged: true, evicted: 0 });
    expect(planSize(sid)).toBe(2);
    const staged = stagedChanges(sid);
    expect(staged.map((c) => c.rel)).toEqual(["a.txt", "b.txt"]);
    expect(staged[0]).toEqual({ resolved: "/ws/a.txt", rel: "a.txt", before: null, after: "one\n", tool: "write" });
    expect(staged[1]?.before).toBe("before\n");
    expect(staged[1]?.tool).toBe("edit");
  });

  test("a repeated write of one path stays two entries, in order", () => {
    const sid = `${SESSION}-repeat`;
    stageWrite(sid, change("a.txt", "v1\n"));
    stageWrite(sid, change("a.txt", "v2\n"));

    expect(planSize(sid)).toBe(2);
    expect(stagedChanges(sid).map((c) => c.after)).toEqual(["v1\n", "v2\n"]);
  });

  test("stagedChanges hands out a copy, not the store", () => {
    const sid = `${SESSION}-copy`;
    stageWrite(sid, change("a.txt", "one\n"));

    const list = stagedChanges(sid) as StagedChange[];
    list.push(change("injected.txt", "x\n"));
    expect(planSize(sid)).toBe(1);
    expect(stagedChanges(sid).map((c) => c.rel)).toEqual(["a.txt"]);
  });

  test("discard drops one path, then everything, and counts what it removed", () => {
    const sid = `${SESSION}-discard`;
    stageWrite(sid, change("a.txt", "1\n"));
    stageWrite(sid, change("b.txt", "2\n"));
    stageWrite(sid, change("c.txt", "3\n"));

    expect(discardStaged(sid, "b.txt")).toBe(1);
    expect(stagedChanges(sid).map((c) => c.rel)).toEqual(["a.txt", "c.txt"]);
    expect(discardStaged(sid, "never-staged.txt")).toBe(0);
    expect(discardStaged(sid)).toBe(2);
    expect(planSize(sid)).toBe(0);
    expect(stagedChanges(sid)).toEqual([]);
    // A session with no stage is not an error: nothing to drop is 0.
    expect(discardStaged(sid)).toBe(0);
    expect(discardStaged("plan-unknown-session")).toBe(0);
  });

  test("takeStaged hands the list over and clears the stage", () => {
    const sid = `${SESSION}-take`;
    stageWrite(sid, change("a.txt", "one\n"));
    stageWrite(sid, change("b.txt", "two\n"));

    const taken = takeStaged(sid);
    expect(taken.map((c) => c.rel)).toEqual(["a.txt", "b.txt"]);
    expect(planSize(sid)).toBe(0);
    expect(stagedChanges(sid)).toEqual([]);
    // Handing it over twice must not hand out the same plan twice.
    expect(takeStaged(sid)).toEqual([]);
    expect(discardStaged(sid)).toBe(0);
  });

  test("the change-count cap evicts the oldest first and reports it", () => {
    const sid = `${SESSION}-cap-count`;
    for (let i = 0; i < MAX_STAGED_CHANGES; i += 1) {
      expect(stageWrite(sid, change(`f${i}.txt`, "one\n")).evicted).toBe(0);
    }
    expect(planSize(sid)).toBe(MAX_STAGED_CHANGES);

    const overflow = stageWrite(sid, change("overflow.txt", "two\n"));
    expect(overflow).toEqual({ staged: true, evicted: 1 });
    expect(planSize(sid)).toBe(MAX_STAGED_CHANGES);
    const rels = stagedChanges(sid).map((c) => c.rel);
    expect(rels).not.toContain("f0.txt");
    expect(rels[0]).toBe("f1.txt");
    expect(rels.at(-1)).toBe("overflow.txt");
  });

  test("the byte cap evicts the oldest first and reports it", () => {
    const sid = `${SESSION}-cap-bytes`;
    const big = "x".repeat(600 * 1024);

    expect(stageWrite(sid, change("a.txt", big))).toEqual({ staged: true, evicted: 0 });
    expect(stageWrite(sid, change("b.txt", big))).toEqual({ staged: true, evicted: 1 });
    expect(stagedChanges(sid).map((c) => c.rel)).toEqual(["b.txt"]);
  });

  test("a change too large for an empty stage is refused, not staged", () => {
    const sid = `${SESSION}-oversized`;
    stageWrite(sid, change("keep.txt", "small\n"));

    const report = stageWrite(sid, change("huge.txt", "x".repeat(MAX_STAGED_BYTES + 1)));
    expect(report).toEqual({ staged: false, evicted: 0 });
    // The refusal must not have cleared the plan to make room for itself.
    expect(planSize(sid)).toBe(1);
    expect(stagedChanges(sid)[0]?.rel).toBe("keep.txt");
  });
});

describe("unifiedDiff", () => {
  test("identical text is not a change", () => {
    expect(unifiedDiff("same\nlines\n", "same\nlines\n", "f.txt")).toBe("");
    expect(unifiedDiff(null, "", "new.txt")).toBe("");
    // CRLF and LF are the same lines: the same edit on two checkouts compares equal.
    expect(unifiedDiff("a\r\nb\r\n", "a\nb\n", "f.txt")).toBe("");
  });

  test("a changed middle line keeps three lines of context each side", () => {
    const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
    const after = "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n";

    expect(unifiedDiff(before, after, "f.txt")).toBe(
      [
        "--- f.txt",
        "+++ f.txt",
        "@@ -1,7 +1,7 @@",
        " one",
        " two",
        " three",
        "-four",
        "+FOUR",
        " five",
        " six",
        " seven",
        "",
      ].join("\n"),
    );
  });

  test("a new file diffs against /dev/null", () => {
    expect(unifiedDiff(null, "alpha\nbeta\n", "new.txt")).toBe(
      ["--- /dev/null", "+++ new.txt", "@@ -0,0 +1,2 @@", "+alpha", "+beta", ""].join("\n"),
    );
  });

  test("a deletion and a pure append each get their own hunk header", () => {
    expect(unifiedDiff("a\nb\n", "", "gone.txt")).toBe(
      ["--- gone.txt", "+++ gone.txt", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"),
    );
    expect(unifiedDiff("a\n", "a\nb\n", "f.txt")).toBe(
      ["--- f.txt", "+++ f.txt", "@@ -1,1 +1,2 @@", " a", "+b", ""].join("\n"),
    );
  });

  test("changes further apart than twice the context become separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n");

    const diff = unifiedDiff(before, after, "f.txt");
    expect(diff.match(/^@@ /gm)?.length).toBe(2);
    expect(diff).toContain("-line 2");
    expect(diff).toContain("+line two");
    expect(diff).toContain("-line 28");
    expect(diff).toContain("+line twenty-eight");
  });

  test("a diff longer than the cap names how many lines were dropped", () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${i + 1}`).join("\n") + "\n";
    const after = Array.from({ length: 50 }, (_, i) => `new ${i + 1}`).join("\n") + "\n";
    // Full diff: 2 file headers + 1 hunk header + 50 removals + 50 additions.
    const full = unifiedDiff(before, after, "big.txt");
    expect(full.split("\n").filter((line) => line !== "").length).toBe(103);

    const capped = unifiedDiff(before, after, "big.txt", 10);
    const lines = capped.split("\n").filter((line) => line !== "");
    expect(lines.length).toBe(10);
    expect(lines.at(-1)).toBe("... 94 more lines");
  });

  test("the same inputs always produce the same bytes", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nB\nc\nD\n";

    const once = unifiedDiff(before, after, "f.txt");
    expect(unifiedDiff(before, after, "f.txt")).toBe(once);
    expect(unifiedDiff(before, after, "f.txt")).toBe(once);
    // A no-op cap still returns a stable (capped) string.
    expect(unifiedDiff(before, after, "f.txt", 5)).toBe(unifiedDiff(before, after, "f.txt", 5));
  });
});

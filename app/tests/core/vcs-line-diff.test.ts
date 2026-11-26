/**
 * vcs-line-diff.test.ts — pure LCS line diff + unified patch (VCS surface).
 * Zero-dependency replacement for upstream's `similar` crate usage. Used by
 * hunk generation/review; no git subprocess, no file I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  diffLines,
  unifiedPatch,
  type DiffOp,
} from "../../src/core/vcs-line-diff";

describe("VCS line diff (pure LCS)", () => {
  test("diffLines emits equal/insert/delete ops", () => {
    const ops = diffLines("a\nb\nc\n", "a\nx\nc\n");
    expect(ops).toEqual([
      { kind: "equal", text: "a" },
      { kind: "delete", text: "b" },
      { kind: "insert", text: "x" },
      { kind: "equal", text: "c" },
    ] as DiffOp[]);
  });

  test("identical content yields only equal ops", () => {
    const ops = diffLines("a\nb\n", "a\nb\n");
    expect(ops.every((o) => o.kind === "equal")).toBe(true);
  });

  test("a pure insertion and a pure deletion", () => {
    expect(diffLines("", "a\nb\n").filter((o) => o.kind === "insert").map((o) => o.text)).toEqual(["a", "b"]);
    expect(diffLines("a\nb\n", "").filter((o) => o.kind === "delete").map((o) => o.text)).toEqual(["a", "b"]);
  });

  test("unifiedPatch produces a parseable @@ hunk with context", () => {
    const patch = unifiedPatch("old.txt", "new.txt", "a\nb\nc\nd\n", "a\nB\nc\nd\n", 1);
    expect(patch).toContain("--- a/old.txt");
    expect(patch).toContain("+++ b/new.txt");
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(patch).toContain("-b");
    expect(patch).toContain("+B");
  });

  test("identical content produces an empty patch", () => {
    expect(unifiedPatch("f", "f", "a\n", "a\n")).toBe("");
  });
});

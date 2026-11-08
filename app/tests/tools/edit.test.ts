/** `edit` — exact replacement, ambiguity handling, all:true, on-disk result. */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { editTool } from "../../src/tools/edit";
import { makeWorkspace, mockToolContext, readFixture, tempRoot, writeFixture } from "./helpers";

describe("edit tool", () => {
  test("replaces the single exact match and reports it", async () => {
    const ws = makeWorkspace({ "f.txt": "hello world\n" });
    const r = await editTool.execute({ path: "f.txt", old: "world", new: "there" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("hello there\n");
  });

  test("replaces a multi-line old string", async () => {
    const ws = makeWorkspace({ "f.txt": "start\nmiddle\nend\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "middle\nend", new: "done" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("start\ndone\n");
  });

  test("inserts replacement text literally (no `$` expansion)", async () => {
    const ws = makeWorkspace({ "f.txt": "cost: X\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "X", new: "$& $$1 [all]" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("cost: $& $$1 [all]\n");
  });

  test("deletes text when the replacement is empty", async () => {
    const ws = makeWorkspace({ "f.txt": "keep drop keep2\n" });
    const r = await editTool.execute({ path: "f.txt", old: " drop", new: "" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("keep keep2\n");
  });

  test("fails when the old string is not found and leaves the file alone", async () => {
    const ws = makeWorkspace({ "f.txt": "hello world\n" });
    const r = await editTool.execute({ path: "f.txt", old: "absent", new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    // NF-069 ladder: the failure is diff-shaped feedback now, pinned in full by
    // tests/tools/edit-ladder.test.ts; the first line stays byte-compatible.
    expect(r.error.startsWith("old string not found in f.txt")).toBe(true);
    expect(r.error).toContain("no similar lines found");
    expect(readFixture(ws, "f.txt")).toBe("hello world\n");
  });

  test("refuses multiple matches unless all:true is set", async () => {
    const ws = makeWorkspace({ "f.txt": "dup\ndup\n" });
    const r = await editTool.execute({ path: "f.txt", old: "dup", new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("found 2 matches in f.txt");
    expect(r.error).toContain("all:true");
    expect(readFixture(ws, "f.txt")).toBe("dup\ndup\n");
  });

  test("replaces every occurrence with all:true", async () => {
    const ws = makeWorkspace({ "f.txt": "dup and dup and dup\n" });
    const r = await editTool.execute({ path: "f.txt", old: "dup", new: "one", all: true }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 3 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("one and one and one\n");
  });

  test("counts non-overlapping occurrences for all:true", async () => {
    const ws = makeWorkspace({ "f.txt": "aaaa\n" });
    const r = await editTool.execute({ path: "f.txt", old: "aa", new: "b", all: true }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 2 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("bb\n");
  });

  test("accepts all:true with a single match", async () => {
    const ws = makeWorkspace({ "f.txt": "only one here\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "one", new: "two", all: true },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt");
  });

  test("rejects an empty old string", async () => {
    const ws = makeWorkspace({ "f.txt": "hello\n" });
    const ctx = mockToolContext({ cwd: ws });
    const r = await editTool.execute({ path: "f.txt", old: "", new: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("old must not be empty");
    expect(ctx.guardCalls.length).toBe(0);
    expect(readFixture(ws, "f.txt")).toBe("hello\n");
  });

  test("requires path, old and new", async () => {
    const ctx = mockToolContext();
    expect((await editTool.execute({}, ctx)).error).toBe("path is required");
    expect((await editTool.execute({ path: "f.txt" }, ctx)).error).toBe("old is required");
    expect((await editTool.execute({ path: "f.txt", old: "a" }, ctx)).error).toBe("new is required");
    expect(ctx.guardCalls.length).toBe(0);
  });

  test("returns ok:false for a missing file", async () => {
    const ws = makeWorkspace();
    const r = await editTool.execute({ path: "nope.txt", old: "a", new: "b" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("file not found: nope.txt");
  });

  test("refuses a binary file", async () => {
    const ws = makeWorkspace({ "bin.dat": new Uint8Array([0x61, 0x00, 0x62]) });
    const r = await editTool.execute({ path: "bin.dat", old: "a", new: "b" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("binary file (contains a NUL byte): bin.dat");
  });

  test("asks for approval with the replacement count and honours a decline", async () => {
    const ws = makeWorkspace({ "f.txt": "dup dup\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await editTool.execute({ path: "f.txt", old: "dup", new: "one", all: true }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.write", target: `${ws}/f.txt` }]);
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0].title).toBe("Edit f.txt");
    expect(ctx.approveCalls[0].detail).toBe("2 occurrence(s)");
    expect(ctx.approveCalls[0].kind).toBe("fs.write");
    expect(readFixture(ws, "f.txt")).toBe("dup dup\n");
  });

  test("edits when an ask is approved", async () => {
    const ws = makeWorkspace({ "f.txt": "before\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: true });
    const r = await editTool.execute({ path: "f.txt", old: "before", new: "after" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.approveCalls[0].detail).toBe("1 occurrence(s)");
    expect(readFixture(ws, "f.txt")).toBe("after\n");
  });

  test("a concurrent write during the approval window is refused as a stale preimage", async () => {
    const ws = makeWorkspace({ "f.txt": "one two\n" });
    let raced = false;
    const ctx = mockToolContext({
      cwd: ws,
      decision: "ask",
      approve: () => {
        raced = true;
        writeFixture(ws, "f.txt", "ONE two\n"); // the concurrent writer wins the window
        return true;
      },
    });
    const r = await editTool.execute({ path: "f.txt", old: "one", new: "uno" }, ctx);
    expect(r.ok).toBe(false);
    // docs/09 §8.2's term: a `Conflict` with the preimage digests, no write.
    expect(r.error).toContain("HZ_PRECONDITION_FAILED: edit refused: preimage changed");
    expect(r.error).toContain("expected sha256");
    expect(r.error).toContain("actual sha256");
    expect(raced).toBe(true);
    expect(ctx.approveCalls.length).toBe(1);
    expect(readFixture(ws, "f.txt")).toBe("ONE two\n"); // no lost update
  });

  test("two sequential edits to the same file in one message both land (fresh preimage each)", async () => {
    const ws = makeWorkspace({ "f.txt": "alpha beta gamma\n" });
    const ctx = mockToolContext({ cwd: ws });
    const first = await editTool.execute({ path: "f.txt", old: "alpha", new: "A" }, ctx);
    const second = await editTool.execute({ path: "f.txt", old: "beta", new: "B" }, ctx);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("A B gamma\n");
  });

  test("reports a policy denial without editing", async () => {
    const ws = makeWorkspace({ "f.txt": "hello\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "read-only workspace" });
    const r = await editTool.execute({ path: "f.txt", old: "hello", new: "bye" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: read-only workspace");
    expect(ctx.approveCalls.length).toBe(0);
    expect(readFixture(ws, "f.txt")).toBe("hello\n");
  });

  test("edits a file outside the workspace once approved", async () => {
    const ws = makeWorkspace();
    const outside = writeFixture(tempRoot(), "outside.txt", "old value\n");
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: true });
    const r = await editTool.execute({ path: outside, old: "old", new: "new" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls[0].target).toBe(outside);
    expect(readFileSync(outside, "utf8")).toBe("new value\n");
  });
});

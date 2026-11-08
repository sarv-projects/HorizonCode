/**
 * edit-ladder.test.ts — NF-069 / NF-052 extensions (docs/30 §2 A-1…A-5).
 *
 * The escalating ladder: exact → relative-indent normalisation → 3-way
 * (trim) merge → line-patch, each applied only when unique. Failures return
 * diff-shaped feedback (closest actual lines, REPLACE-already-present) and the
 * bounded reflection slot (max_reflections = 1) disables fuzzy matching for the
 * file until an edit succeeds. Error strings are a contract: the fixtures below
 * are byte-identical (A-5).
 */

import { describe, expect, test } from "bun:test";
import { MAX_EDIT_REFLECTIONS, editTool } from "../../src/tools/edit";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

/**
 * A context whose session has already READ the fixture — the flow the
 * read-before-write gate requires before a fuzzy rung may reconstruct a location
 * (audit finding 2). Rung 1 (an exact match) deliberately keeps the un-read
 * context, which documents the exemption.
 */
async function ctxHavingRead(ws: string, opts: { rel?: string; sessionId?: string } = {}) {
  const ctx = mockToolContext(opts.sessionId === undefined ? { cwd: ws } : { cwd: ws, sessionId: opts.sessionId });
  const read = await readTool.execute({ path: opts.rel ?? "f.txt" }, ctx);
  if (!read.ok) throw new Error(`fixture read failed: ${read.error}`);
  return ctx;
}

describe("the edit ladder applies only unique rungs", () => {
  test("rung 1: an exact match keeps the byte-identical output (no rung suffix)", async () => {
    const ws = makeWorkspace({ "f.txt": "hello world\n" });
    const r = await editTool.execute({ path: "f.txt", old: "world", new: "there" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("hello there\n");
  });

  test("rung 2: relative-indent normalisation matches and re-indents into the file", async () => {
    const ws = makeWorkspace({
      "f.txt": "class A {\n    void m() {\n        x = 1;\n    }\n}\n",
    });
    const r = await editTool.execute(
      { path: "f.txt", old: "void m() {\n    x = 1;\n}", new: "void m() {\n    x = 2;\n}" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via indent-normalised)");
    expect(readFixture(ws, "f.txt")).toBe("class A {\n    void m() {\n        x = 2;\n    }\n}\n");
  });

  test("rung 3: the trim merge absorbs trailing whitespace and tabs", async () => {
    const ws = makeWorkspace({ "f.txt": "fn main() {  \n\tlet x = 1;\n}\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "fn main() {\nlet x = 1;\n}", new: "fn main() {\nlet y = 2;\n}" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via 3-way merge)");
    expect(readFixture(ws, "f.txt")).toBe("fn main() {\nlet y = 2;\n}\n");
  });

  test("rung 4: a unique anchor pair is patched as lines", async () => {
    const ws = makeWorkspace({ "f.txt": "header\nlineA\nold interior 1\nold interior 2\nlineB\nfooter\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "lineA\nfoo\nbar\nlineB", new: "lineA\nNEW1\nNEW2\nlineB" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via line-patch)");
    expect(readFixture(ws, "f.txt")).toBe("header\nlineA\nNEW1\nNEW2\nlineB\nfooter\n");
  });

  test("the ladder stops at the first rung that matches: exact beats fuzzy", async () => {
    // The exact string sits inside a block the indent rung would also match.
    const ws = makeWorkspace({ "f.txt": "    alpha\n    beta\n" });
    const r = await editTool.execute({ path: "f.txt", old: "alpha\n    beta", new: "X\n    Y" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt"); // exact — no rung suffix
    expect(readFixture(ws, "f.txt")).toBe("    X\n    Y\n");
  });
});

describe("ambiguous fuzzy matches are refused, never guessed", () => {
  test("two identical blocks fail with the candidate lines and do not write", async () => {
    const file = "begin\n    alpha\n    beta\nend\nbegin\n    alpha\n    beta\nend\n";
    const ws = makeWorkspace({ "f.txt": file });
    const r = await editTool.execute(
      { path: "f.txt", old: "alpha\nbeta", new: "alpha2\nbeta2" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "near-match is ambiguous in f.txt after indent-normalised matching: 2 candidates (lines 2-3, 6-7); provide more context (no edit applied)\n" +
        "reflection: 1/1 \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file",
    );
    expect(readFixture(ws, "f.txt")).toBe(file);
  });
});

describe("diff-shaped failure feedback (A-3), byte-identical (A-5)", () => {
  test("not found, nothing similar, first failure: the full text", async () => {
    const ws = makeWorkspace({ "f.txt": "hello world\n" });
    const r = await editTool.execute({ path: "f.txt", old: "absent", new: "x" }, await ctxHavingRead(ws));
    expect(r.error).toBe(
      "old string not found in f.txt\n" +
        "searched: exact \u2192 indent-normalised \u2192 3-way merge \u2192 line-patch; no unique match\n" +
        "no similar lines found\n" +
        "reflection: " +
        `${MAX_EDIT_REFLECTIONS}/${MAX_EDIT_REFLECTIONS} \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file`,
    );
  });

  test("the REPLACE text already present is called out", async () => {
    const ws = makeWorkspace({ "f.txt": "todo: done\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "todo: pending", new: "todo: done" },
      await ctxHavingRead(ws),
    );
    expect(r.error).toBe(
      "old string not found in f.txt\n" +
        "searched: exact \u2192 indent-normalised \u2192 3-way merge \u2192 line-patch; no unique match\n" +
        "no similar lines found\n" +
        "the new text already appears at lines 1-1 \u2014 the file may already contain this edit\n" +
        "reflection: 1/1 \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file",
    );
    expect(readFixture(ws, "f.txt")).toBe("todo: done\n");
  });

  test("the closest actual lines are rendered as a diff", async () => {
    const ws = makeWorkspace({ "f.txt": "fn handler(a) {\n  let x = 2;\n}\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "fn handler() {\n  let x = 1;\n}", new: "fn handler() {\n  let x = 3;\n}" },
      await ctxHavingRead(ws),
    );
    expect(r.error).toBe(
      "old string not found in f.txt\n" +
        "searched: exact \u2192 indent-normalised \u2192 3-way merge \u2192 line-patch; no unique match\n" +
        "closest actual lines (lines 1-3, 33% similar):\n" +
        "  - fn handler() {\n" +
        "  + fn handler(a) {\n" +
        "  -   let x = 1;\n" +
        "  +   let x = 2;\n" +
        "  - }\n" +
        "  + }\n" +
        "reflection: 1/1 \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file",
    );
  });

  test("multiple exact matches name their lines (byte-stable)", async () => {
    const ws = makeWorkspace({ "f.txt": "dup\ndup\n" });
    const r = await editTool.execute({ path: "f.txt", old: "dup", new: "x" }, mockToolContext({ cwd: ws }));
    expect(r.error).toBe("found 2 matches in f.txt (lines 1, 2); set all:true or provide more context");
  });
});

describe("the bounded reflection slot (A-4)", () => {
  const FUZZY_FILE = "unique-line\n    alpha\n    beta\n";

  test("a second failure disables fuzzy matching until an edit succeeds", async () => {
    const ws = makeWorkspace({ "f.txt": FUZZY_FILE });
    const ctx = await ctxHavingRead(ws, { sessionId: "reflect-session" });

    const first = await editTool.execute({ path: "f.txt", old: "no such text here", new: "x" }, ctx);
    expect(first.ok).toBe(false);
    expect(first.error).toContain("reflection: 1/1");

    // The indent rung would match this block, but the reflection slot is spent.
    const second = await editTool.execute({ path: "f.txt", old: "alpha\nbeta", new: "alpha2\nbeta2" }, ctx);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("searched: exact only (fuzzy matching disabled after the reflection limit)");
    expect(second.error).toContain(`reflection limit reached (max_reflections=${MAX_EDIT_REFLECTIONS})`);
    expect(readFixture(ws, "f.txt")).toBe(FUZZY_FILE);

    // A clean exact edit resets the slot for the file…
    const clean = await editTool.execute({ path: "f.txt", old: "unique-line", new: "unique!" }, ctx);
    expect(clean.ok).toBe(true);

    // …and the fuzzy rung works again.
    const recovered = await editTool.execute({ path: "f.txt", old: "alpha\nbeta", new: "alpha2\nbeta2" }, ctx);
    expect(recovered.ok).toBe(true);
    expect(recovered.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via indent-normalised)");
    expect(readFixture(ws, "f.txt")).toBe("unique!\n    alpha2\n    beta2\n");
  });

  test("the reflection slot is per session: another session is unaffected", async () => {
    const ws = makeWorkspace({ "f.txt": FUZZY_FILE });
    const spent = await ctxHavingRead(ws, { sessionId: "session-spent" });
    await editTool.execute({ path: "f.txt", old: "absent one", new: "x" }, spent);
    await editTool.execute({ path: "f.txt", old: "absent two", new: "x" }, spent);

    const fresh = await ctxHavingRead(ws, { sessionId: "session-fresh" });
    const r = await editTool.execute({ path: "f.txt", old: "alpha\nbeta", new: "a2\nb2" }, fresh);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("matched via indent-normalised");
  });
});

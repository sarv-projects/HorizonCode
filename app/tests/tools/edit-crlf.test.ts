/**
 * edit-crlf.test.ts -- CRLF safety for the edit ladder (FEAT-001).
 *
 * Every rung matches against the LF VIEW of the file (the bytes `read` shows the
 * model), so an LF-only old/new string matches a CRLF file; on write, untouched
 * regions keep their exact bytes and the replaced block takes the matched
 * region's native ending. A CRLF file is NEVER rewritten to LF wholesale. Each
 * assertion here fails if the LF-view / per-region-preservation code is
 * reverted (the old slice-on-"\n"/join-on-"\n" path flattened endings to LF).
 *
 * Fuzzy rungs require the session to have read the file first (the
 * read-before-write gate), so those tests use the ctxHavingRead pattern from
 * edit-ladder.test.ts. The exact rung needs no prior read.
 */

import { describe, expect, test } from "bun:test";
import { editTool } from "../../src/tools/edit";
import { readTool } from "../../src/tools/read";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

async function ctxHavingRead(ws: string, rel = "f.txt") {
  const ctx = mockToolContext({ cwd: ws });
  const read = await readTool.execute({ path: rel }, ctx);
  if (!read.ok) throw new Error(`fixture read failed: ${read.error}`);
  return ctx;
}

describe("(a) a CRLF file edited with an LF old/new string stays CRLF", () => {
  test("exact single-line match keeps every line CRLF", async () => {
    const ws = makeWorkspace({ "f.txt": "alpha\r\nbeta\r\ngamma\r\n" });
    const r = await editTool.execute({ path: "f.txt", old: "beta", new: "BETA" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt"); // exact: no rung suffix
    // The ENTIRE file is still CRLF, including untouched lines.
    expect(readFixture(ws, "f.txt")).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  test("exact multi-line match: the replacement block is CRLF-joined", async () => {
    const ws = makeWorkspace({ "f.txt": "alpha\r\nbeta\r\ngamma\r\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "beta\ngamma", new: "B\nG\nH" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("alpha\r\nB\r\nG\r\nH\r\n");
  });

  test("replaceAll across a CRLF file preserves CRLF on every replacement", async () => {
    const ws = makeWorkspace({ "f.txt": "x\r\nx\r\ny\r\n" });
    const r = await editTool.execute({ path: "f.txt", old: "x", new: "z", all: true }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 2 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("z\r\nz\r\ny\r\n");
  });

  test("a fuzzy rung (indent-normalised) on a CRLF file keeps CRLF", async () => {
    const ws = makeWorkspace({ "f.txt": "class A {\r\n    void m() {\r\n        x = 1;\r\n    }\r\n}\r\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "void m() {\n    x = 1;\n}", new: "void m() {\n    x = 2;\n}" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt (matched via indent-normalised)");
    expect(readFixture(ws, "f.txt")).toBe("class A {\r\n    void m() {\r\n        x = 2;\r\n    }\r\n}\r\n");
  });
});

describe("(b) a mixed-ending file keeps each untouched region's ending", () => {
  test("untouched CRLF lines stay CRLF; an edit in an LF region stays LF", async () => {
    // Lines 1,3,4 are CRLF; line 2 ("b") is LF. Editing the LF line must leave
    // the CRLF lines byte-exact and the replaced region takes the LF ending.
    const ws = makeWorkspace({ "f.txt": "a\r\nb\nc\r\nd\r\n" });
    const r = await editTool.execute({ path: "f.txt", old: "b", new: "B" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("a\r\nB\nc\r\nd\r\n");
  });

  test("editing a CRLF line in a mixed file keeps that region CRLF", async () => {
    const ws = makeWorkspace({ "f.txt": "a\nb\r\nc\n" });
    const r = await editTool.execute({ path: "f.txt", old: "b", new: "B" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("a\nB\r\nc\n");
  });
});

describe("(c) pure-LF behaviour is unchanged (regression guard)", () => {
  test("exact LF edit is byte-identical to before", async () => {
    const ws = makeWorkspace({ "f.txt": "hello world\n" });
    const r = await editTool.execute({ path: "f.txt", old: "world", new: "there" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Replaced 1 occurrence(s) in f.txt");
    expect(readFixture(ws, "f.txt")).toBe("hello there\n");
  });

  test("a pure-LF fuzzy rung still joins on LF", async () => {
    const ws = makeWorkspace({ "f.txt": "class A {\n    void m() {\n        x = 1;\n    }\n}\n" });
    const r = await editTool.execute(
      { path: "f.txt", old: "void m() {\n    x = 1;\n}", new: "void m() {\n    x = 2;\n}" },
      await ctxHavingRead(ws),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("class A {\n    void m() {\n        x = 2;\n    }\n}\n");
  });

  test("a file with no trailing newline keeps its shape", async () => {
    const ws = makeWorkspace({ "f.txt": "alpha\nbeta" });
    const r = await editTool.execute({ path: "f.txt", old: "beta", new: "GAMMA" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("alpha\nGAMMA");
  });
});

describe("(d) write normalises new-file endings via the shared helper", () => {
  test("a new file with CRLF content is written CRLF", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute(
      { path: "new.txt", content: "a\r\nb\r\nc\r\n" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "new.txt")).toBe("a\r\nb\r\nc\r\n");
  });

  test("a new file with pure-LF content is byte-identical (no-op)", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute({ path: "new.txt", content: "a\nb\nc\n" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "new.txt")).toBe("a\nb\nc\n");
    expect(r.output).toBe("Wrote 3 lines (6 bytes) to new.txt");
  });

  test("overwriting a CRLF file with LF-only content keeps CRLF", async () => {
    const ws = makeWorkspace({ "f.txt": "one\r\ntwo\r\n" });
    const ctx = mockToolContext({ cwd: ws });
    expect((await readTool.execute({ path: "f.txt" }, ctx)).ok).toBe(true);
    const r = await writeTool.execute({ path: "f.txt", content: "alpha\nbeta\n" }, ctx);
    expect(r.ok).toBe(true);
    // The model emitted LF, but the existing file was CRLF: keep CRLF.
    expect(readFixture(ws, "f.txt")).toBe("alpha\r\nbeta\r\n");
  });
});

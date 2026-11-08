/**
 * The read-before-write gate (audit finding 2): a file this session never read
 * cannot be replaced wholesale, and the fuzzy rungs of `edit` stay closed.
 *
 * Only `read` writes the ledger, so these tests drive the real tools against a
 * shared `sessionId` rather than reaching into the ledger directly — the gate is
 * what is under test, not the bookkeeping.
 */

import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { editTool } from "../../src/tools/edit";
import { readTool } from "../../src/tools/read";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

function session(): { id: string } {
  return { id: `ledger-${Math.random().toString(36).slice(2, 10)}` };
}

describe("write over an existing file", () => {
  test("is refused when this session has not read it, and the file is untouched", async () => {
    const ws = makeWorkspace({ "notes.md": "original content\n" });
    const s = session();
    const r = await writeTool.execute(
      { path: "notes.md", content: "replacement\n" },
      mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HZ_PRECONDITION_FAILED");
    expect(r.error).toContain("has not read it");
    expect(readFixture(ws, "notes.md")).toBe("original content\n");
  });

  test("is allowed once the session has read it", async () => {
    const ws = makeWorkspace({ "notes.md": "original content\n" });
    const s = session();
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id });
    expect((await readTool.execute({ path: "notes.md" }, ctx)).ok).toBe(true);
    const r = await writeTool.execute({ path: "notes.md", content: "replacement\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "notes.md")).toBe("replacement\n");
  });

  test("a read in a different session does not count", async () => {
    const ws = makeWorkspace({ "notes.md": "original\n" });
    const reader = mockToolContext({ cwd: ws, workspace: ws, sessionId: "session-one" });
    expect((await readTool.execute({ path: "notes.md" }, reader)).ok).toBe(true);
    const writer = mockToolContext({ cwd: ws, workspace: ws, sessionId: "session-two" });
    const r = await writeTool.execute({ path: "notes.md", content: "replacement\n" }, writer);
    expect(r.ok).toBe(false);
    expect(readFixture(ws, "notes.md")).toBe("original\n");
  });

  test("force:true replaces it without a read, and creates are never gated", async () => {
    const ws = makeWorkspace({ "notes.md": "original\n" });
    const s = session();
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id });
    const forced = await writeTool.execute({ path: "notes.md", content: "forced\n", force: true }, ctx);
    expect(forced.ok).toBe(true);
    expect(readFixture(ws, "notes.md")).toBe("forced\n");
    // A path that does not exist yet has nothing to destroy.
    const created = await writeTool.execute({ path: "fresh.md", content: "new\n" }, ctx);
    expect(created.ok).toBe(true);
    expect(readFixture(ws, "fresh.md")).toBe("new\n");
  });
});

describe("edit and the fuzzy rungs", () => {
  test("an exact match still works without a prior read", async () => {
    const ws = makeWorkspace({ "code.ts": "const a = 1;\nconst b = 2;\n" });
    const s = session();
    const r = await editTool.execute(
      { path: "code.ts", old: "const b = 2;", new: "const b = 3;" },
      mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id }),
    );
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "code.ts")).toContain("const b = 3;");
  });

  test("a non-matching old string is refused when the file was never read", async () => {
    const ws = makeWorkspace({ "code.ts": "const a = 1;\n    const b = 2;\n    return b;\n" });
    const s = session();
    const r = await editTool.execute(
      { path: "code.ts", old: "const b = 2;\nreturn b;", new: "const b = 3;\nreturn b;" },
      mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HZ_PRECONDITION_FAILED");
    expect(r.error).toContain("has not read the file");
    expect(readFixture(ws, "code.ts")).toContain("const b = 2;");
  });

  test("the same non-matching edit reaches the fuzzy ladder after a read", async () => {
    const ws = makeWorkspace({ "code.ts": "const a = 1;\n    const b = 2;\n    return b;\n" });
    const s = session();
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id });
    expect((await readTool.execute({ path: "code.ts" }, ctx)).ok).toBe(true);
    const r = await editTool.execute({ path: "code.ts", old: "const b = 2;\nreturn b;", new: "const b = 3;\nreturn b;" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("matched via");
    expect(readFixture(ws, "code.ts")).toContain("const b = 3;");
  });
});

describe("the ledger follows the realpath", () => {
  test("a read through a symlink counts for its target", async () => {
    const ws = makeWorkspace({ "real.md": "real content\n" });
    symlinkSync(path.join(ws, "real.md"), path.join(ws, "link.md"));
    const s = session();
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id });
    expect((await readTool.execute({ path: "link.md" }, ctx)).ok).toBe(true);
    // The write names the target directly: same file, so the gate is satisfied.
    const r = await writeTool.execute({ path: "real.md", content: "via link\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "real.md")).toBe("via link\n");
  });

  test("an empty file read is remembered", async () => {
    const ws = makeWorkspace({ "empty.txt": "" });
    const s = session();
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: s.id });
    expect((await readTool.execute({ path: "empty.txt" }, ctx)).ok).toBe(true);
    const r = await writeTool.execute({ path: "empty.txt", content: "now filled\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "empty.txt")).toBe("now filled\n");
  });
});

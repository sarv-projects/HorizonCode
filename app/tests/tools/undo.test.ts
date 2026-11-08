/**
 * undo.test.ts -- reversing a change must be exact: restore the previous
 * content, remove a file this session created, refuse when the file moved on
 * since (a concurrent edit is not ours to overwrite), and be honest when the
 * previous bytes are not restorable text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { journalSize } from "../../src/tools/change-journal";
import { editTool } from "../../src/tools/edit";
import { readTool } from "../../src/tools/read";
import { undoTool } from "../../src/tools/undo";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext } from "./helpers";

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

describe("undo", () => {
  test("removes a file this session created, and then runs dry", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    const w = await writeTool.execute({ path: "new.txt", content: "hi\n" }, ctx);
    expect(w.ok).toBe(true);
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed new.txt");
    expect(exists(path.join(ws, "new.txt"))).toBe(false);
    const again = await undoTool.execute({}, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("nothing to undo");
  }, 30000);

  test("restores the previous content of an overwritten file", async () => {
    const ws = makeWorkspace({ "a.txt": "old\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "a.txt" }, ctx);
    const w = await writeTool.execute({ path: "a.txt", content: "new\n" }, ctx);
    expect(w.ok).toBe(true);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("new\n");
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Restored a.txt");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("old\n");
  }, 30000);

  test("reverses an edit", async () => {
    const ws = makeWorkspace({ "b.txt": "hello world\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "b.txt" }, ctx);
    const e = await editTool.execute({ path: "b.txt", old: "world", new: "there" }, ctx);
    expect(e.ok).toBe(true);
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("hello there\n");
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("hello world\n");
  }, 30000);

  test("refuses when the file changed since, and keeps the entry", async () => {
    const ws = makeWorkspace({ "c.txt": "v1\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "c.txt" }, ctx);
    await writeTool.execute({ path: "c.txt", content: "v2\n" }, ctx);
    writeFileSync(path.join(ws, "c.txt"), "v3-foreign\n");
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain("changed since");
    expect(readFileSync(path.join(ws, "c.txt"), "utf8")).toBe("v3-foreign\n");
    expect(journalSize(ctx.sessionId)).toBe(1);
  }, 30000);

  test("path-scoped undo touches only the named file", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    await writeTool.execute({ path: "one.txt", content: "1\n" }, ctx);
    await writeTool.execute({ path: "two.txt", content: "2\n" }, ctx);
    const u = await undoTool.execute({ path: "one.txt" }, ctx);
    expect(u.ok).toBe(true);
    expect(exists(path.join(ws, "one.txt"))).toBe(false);
    expect(readFileSync(path.join(ws, "two.txt"), "utf8")).toBe("2\n");
    const u2 = await undoTool.execute({}, ctx);
    expect(u2.ok).toBe(true);
    expect(exists(path.join(ws, "two.txt"))).toBe(false);
  }, 30000);

  test("a forced overwrite of a binary leaves an honest, non-restorable entry", async () => {
    const ws = makeWorkspace({});
    writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const ctx = mockToolContext({ cwd: ws });
    const w = await writeTool.execute({ path: "blob.bin", content: "now text\n", force: true }, ctx);
    expect(w.ok).toBe(true);
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain("not restorable text");
    expect(readFileSync(path.join(ws, "blob.bin"), "utf8")).toBe("now text\n");
  }, 30000);
});

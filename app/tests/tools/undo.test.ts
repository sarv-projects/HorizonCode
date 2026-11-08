/**
 * undo.test.ts -- reversing a change must be exact: restore the previous
 * content, remove a file the change created, refuse when the file moved on
 * since (a concurrent edit is not ours to overwrite), and be honest when the
 * previous bytes are not restorable text or were too large to keep.
 *
 * The journal is workspace-scoped and durable: these tests also pin that a
 * fresh journal instance (a simulated restart) still finds the entry, that a
 * consumed entry does not come back, that the stale-check survives a reload,
 * and that a torn or corrupt journal file is reported instead of being read
 * as empty.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../src/contracts";
import {
  __resetJournalForTests,
  journalPath,
  journalSize,
  lastChange,
} from "../../src/tools/change-journal";
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

/** The quarantined file a corrupt journal was moved to, if any. */
function quarantinedFile(ws: string): string | undefined {
  const dir = path.dirname(journalPath(ws));
  const name = readdirSync(dir).find((entry) => entry.startsWith("undo.jsonl.corrupt-"));
  return name === undefined ? undefined : path.join(dir, name);
}

describe("undo", () => {
  test("removes a file this session created, and then runs dry", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    const w = await writeTool.execute({ path: "new.txt", content: "hi\n" }, ctx);
    expect(w.ok).toBe(true);
    // The record is persisted per workspace under the canonical state root.
    expect(existsSync(journalPath(ws))).toBe(true);
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed new.txt");
    expect(exists(path.join(ws, "new.txt"))).toBe(false);
    expect(journalSize(ctx.sessionId)).toBe(0);
    // The consume tombstone is on disk, not just in memory.
    expect(readFileSync(journalPath(ws), "utf8")).toContain('"consume"');
    const again = await undoTool.execute({}, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("nothing to undo");
    expect(again.error).not.toContain("session-scoped");
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

  test("a fresh journal instance still finds and reverses the change (survives a reload)", async () => {
    const ws = makeWorkspace({ "a.txt": "old\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "a.txt" }, ctx);
    await writeTool.execute({ path: "a.txt", content: "new\n" }, ctx);
    await writeTool.execute({ path: "created.txt", content: "hi\n" }, ctx);
    // The record is on disk with the after-hash the stale-check will need.
    expect(readFileSync(journalPath(ws), "utf8")).toContain(sha256Hex("new\n"));
    __resetJournalForTests(); // a fresh process: no in-memory journal at all
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed created.txt");
    const u2 = await undoTool.execute({ path: "a.txt" }, ctx);
    expect(u2.ok).toBe(true);
    expect(u2.output).toContain("Restored a.txt");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("old\n");
  }, 30000);

  test("the newest live change is found across sessions; path: scopes per file", async () => {
    const ws = makeWorkspace({});
    const one = mockToolContext({ cwd: ws, sessionId: "session-one" });
    const two = mockToolContext({ cwd: ws, sessionId: "session-two" });
    await writeTool.execute({ path: "one.txt", content: "1\n" }, one);
    await writeTool.execute({ path: "two.txt", content: "2\n" }, two);
    // No path: the newest entry overall, even though another session wrote it.
    const u = await undoTool.execute({}, two);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed two.txt");
    // path: scopes to that file, again across sessions.
    const u2 = await undoTool.execute({ path: "one.txt" }, two);
    expect(u2.ok).toBe(true);
    expect(exists(path.join(ws, "one.txt"))).toBe(false);
  }, 30000);

  test("a consumed entry does not come back after a reload", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    await writeTool.execute({ path: "d.txt", content: "d\n" }, ctx);
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    __resetJournalForTests();
    const again = await undoTool.execute({}, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("nothing to undo");
    expect(exists(path.join(ws, "d.txt"))).toBe(false);
    expect(journalSize(ctx.sessionId)).toBe(0);
  }, 30000);

  test("the stale-check holds across a reload, and the entry stays", async () => {
    const ws = makeWorkspace({ "e.txt": "v1\n" });
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "e.txt" }, ctx);
    await writeTool.execute({ path: "e.txt", content: "v2\n" }, ctx);
    __resetJournalForTests();
    writeFileSync(path.join(ws, "e.txt"), "v3-foreign\n");
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain("changed since");
    expect(readFileSync(path.join(ws, "e.txt"), "utf8")).toBe("v3-foreign\n");
    expect(journalSize(ctx.sessionId)).toBe(1);
    __resetJournalForTests();
    const again = await undoTool.execute({}, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("changed since");
  }, 30000);

  test("an oversized previous content is refused, typed, and the hash still records", async () => {
    const ws = makeWorkspace({});
    const big = "x".repeat(300_000);
    writeFileSync(path.join(ws, "big.txt"), big);
    const ctx = mockToolContext({ cwd: ws });
    await readTool.execute({ path: "big.txt" }, ctx);
    const w = await writeTool.execute({ path: "big.txt", content: "small\n" }, ctx);
    expect(w.ok).toBe(true);
    const entry = lastChange(ctx.sessionId);
    expect(entry?.nonRestorable).toBe(true);
    expect(entry?.before).toBeNull();
    expect(entry?.afterSha256).toBe(sha256Hex("small\n"));
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain("nonRestorable");
    expect(u.error).toContain("256 KB");
    expect(readFileSync(path.join(ws, "big.txt"), "utf8")).toBe("small\n");
    expect(journalSize(ctx.sessionId)).toBe(1);
  }, 30000);

  test("a torn tail is skipped, and reported when the journal has nothing", async () => {
    // Torn after a valid record: the earlier record still undoes.
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    await writeTool.execute({ path: "g.txt", content: "g\n" }, ctx);
    appendFileSync(journalPath(ws), '{"id":"torn-partial"', "utf8"); // crash mid-append
    __resetJournalForTests();
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed g.txt");
    // Only a torn line: nothing to undo, and the message says why.
    const ws2 = makeWorkspace({});
    const ctx2 = mockToolContext({ cwd: ws2 });
    mkdirSync(path.dirname(journalPath(ws2)), { recursive: true });
    writeFileSync(journalPath(ws2), '{"id":"torn-partial"');
    __resetJournalForTests();
    const u2 = await undoTool.execute({}, ctx2);
    expect(u2.ok).toBe(false);
    expect(u2.error).toContain("nothing to undo");
    expect(u2.error).toContain("torn");
  }, 30000);

  test("a corrupt journal is quarantined, reported, and restarts empty", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });
    await writeTool.execute({ path: "h.txt", content: "h\n" }, ctx);
    writeFileSync(journalPath(ws), "this is not a journal\n");
    __resetJournalForTests();
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain("nothing to undo");
    expect(u.error).toContain("corrupt");
    expect(u.error).toContain("moved aside");
    // Renamed with its bytes preserved; the unreadable file was never read as empty.
    const kept = quarantinedFile(ws);
    expect(kept).toBeDefined();
    expect(readFileSync(kept as string, "utf8")).toBe("this is not a journal\n");
    expect(existsSync(journalPath(ws))).toBe(false);
    expect(readFileSync(path.join(ws, "h.txt"), "utf8")).toBe("h\n");
    // The journal restarts empty and works again.
    await writeTool.execute({ path: "i.txt", content: "i\n" }, ctx);
    __resetJournalForTests();
    const u2 = await undoTool.execute({}, ctx);
    expect(u2.ok).toBe(true);
    expect(u2.output).toContain("Removed i.txt");
  }, 30000);

  test("a legacy .hzcode workspace keeps its journal there", async () => {
    const ws = makeWorkspace({});
    mkdirSync(path.join(ws, ".hzcode"));
    const ctx = mockToolContext({ cwd: ws });
    const w = await writeTool.execute({ path: "j.txt", content: "j\n" }, ctx);
    expect(w.ok).toBe(true);
    expect(existsSync(path.join(ws, ".hzcode", "undo.jsonl"))).toBe(true);
    expect(existsSync(path.join(ws, ".hz", "state", "undo.jsonl"))).toBe(false);
    __resetJournalForTests();
    const u = await undoTool.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(u.output).toContain("Removed j.txt");
  }, 30000);
});

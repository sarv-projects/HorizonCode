/**
 * undo-symlink.test.ts — D-4: the journal must name the path whose bytes changed.
 *
 * A write through a directory symlink creates the file in the link's real target
 * directory. The journal recorded the lexical link path instead, so undo's
 * "created by this change" branch removed (or, after the link moved, refused)
 * a path that is not the effect. The same lexical record also made the journal
 * lie about what changed.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { reloadFromDisk } from "../../src/tools/change-journal";
import { undoTool } from "../../src/tools/undo";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext, tempRoot } from "./helpers";

describe("undo of a create through a directory symlink", () => {
  test("journals the real target and removes it, keeping the link", async () => {
    const outside = realpathSync(tempRoot());
    const ws = makeWorkspace({});
    const link = path.join(ws, "dirlink");
    symlinkSync(outside, link, "dir");

    const ctx = mockToolContext({ cwd: ws });
    const created = path.join(outside, "created.txt");
    const w = await writeTool.execute({ path: "dirlink/created.txt", content: "X\n" }, ctx);
    expect(w.ok).toBe(true);
    expect(readFileSync(created, "utf8")).toBe("X\n");

    // The journal names the effect: the real file, not the lexical link path.
    const entry = reloadFromDisk(ws).entries.at(-1);
    expect(entry?.path).toBe(created);

    const u = await undoTool.execute({ path: "dirlink/created.txt" }, ctx);
    expect(u.ok).toBe(true);
    expect(existsSync(created)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

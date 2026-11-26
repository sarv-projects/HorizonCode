/**
 * hostile-write.test.ts — path-containment fixtures for the mutating tools and
 * grep. Every fixture plants a symlink inside the workspace that points at a
 * real file/directory OUTSIDE it, then asserts:
 *
 *   - the tool's guard sees the REAL (symlink-resolved) target, never the
 *     lexical "inside" spelling;
 *   - a policy that denies outside targets stops the effect before any byte is
 *     written/removed, and the outside file is byte-for-byte unchanged;
 *   - an `ask` approval for a symlinked target names the resolved target, and a
 *     decline writes nothing;
 *   - grep resolves its root before guarding and never follows a symlink while
 *     walking, so a link to an outside tree is not searched.
 *
 * Fixtures are real files under the OS temp dir; no network is used.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { GuardAction, GuardDecision } from "../../src/contracts";
import { applyPatchTool } from "../../src/tools/apply-patch";
import { astEditTool } from "../../src/tools/ast-edit";
import { editTool } from "../../src/tools/edit";
import { grepTool } from "../../src/tools/grep";
import { readTool } from "../../src/tools/read";
import { undoTool } from "../../src/tools/undo";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext, tempRoot, withoutRipgrep, writeFixture } from "./helpers";

/** Policy: allow targets whose REAL path is inside `root`, deny everything else. */
function insideOnly(root: string) {
  return (action: GuardAction): GuardDecision =>
    action.target === root || action.target.startsWith(root + "/")
      ? { decision: "allow" }
      : { decision: "deny", reason: "outside workspace" };
}

/** The real workspace root, which is what the tools' guard targets compare to. */
function realWorkspace(ws: string): string {
  return realpathSync(ws);
}

/** Wrap patch body lines in the apply_patch grammar's envelope. */
function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe("hostile write fixtures (file symlink -> outside)", () => {
  test("write is denied on the real target and leaves the outside file untouched", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await writeTool.execute({ path: "escape.txt", content: "PWNED\n" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(r.error).toContain("outside workspace");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET\n");
  });

  test("write ask names the resolved target; a decline writes nothing", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await writeTool.execute({ path: "escape.txt", content: "PWNED\n" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0]?.detail).toContain(secret);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET\n");
  });

  test("write of a NEW file through a directory symlink is denied on the real target", async () => {
    const outside = realpathSync(tempRoot());
    const ws = makeWorkspace({});
    symlinkSync(outside, path.join(ws, "dirlink"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await writeTool.execute({ path: "dirlink/new.txt", content: "PWNED\n" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(path.join(outside, "new.txt"));
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  test("edit (exact) is denied on the real target and leaves the outside file untouched", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await editTool.execute({ path: "escape.txt", old: "TOP", new: "PWNED" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET\n");
  });

  test("edit {all:true} is denied on the real target (the Bun path, not the kernel route)", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await editTool.execute({ path: "escape.txt", old: "SECRET", new: "LEAK", all: true }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET TOP SECRET\n");
  });

  test("edit ask names the resolved target; a decline writes nothing", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await editTool.execute({ path: "escape.txt", old: "TOP", new: "PWNED" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(ctx.approveCalls[0]?.detail).toContain(secret);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET\n");
  });

  test("apply_patch update is refused before guard when symlink escapes workspace and leaves the outside file untouched", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOP SECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: escape.txt\n@@\n-TOP SECRET\n+PWNED") },
      ctx,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("escapes the workspace");
    expect(ctx.guardCalls.length).toBe(0);
    expect(readFileSync(secret, "utf8")).toBe("TOP SECRET\n");
  });

  test("apply_patch Add File through a directory symlink is refused before guard", async () => {
    const outside = realpathSync(tempRoot());
    const ws = makeWorkspace({});
    symlinkSync(outside, path.join(ws, "dirlink"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await applyPatchTool.execute(
      { input: wrap("*** Add File: dirlink/new.txt\n+owned") },
      ctx,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("escapes the workspace");
    expect(ctx.guardCalls.length).toBe(0);
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  test("ast_edit is denied on the real target and leaves the outside file untouched", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.ts", "foo(a);\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "escape.ts"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await astEditTool.execute({ path: "escape.ts", pat: "foo($A)", out: "bar($A)" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
    expect(readFileSync(secret, "utf8")).toBe("foo(a);\n");
  });

  test("undo is denied on the real target when the recorded file became a symlink", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "new\n");
    const ws = makeWorkspace({ "a.txt": "old\n" });
    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });

    expect((await readTool.execute({ path: "a.txt" }, ctx)).ok).toBe(true);
    expect((await writeTool.execute({ path: "a.txt", content: "new\n" }, ctx)).ok).toBe(true);

    // The change is journaled; now the path is swapped for a link whose real
    // target already holds the recorded post-write bytes (so the stale-check
    // passes and only the guard stands between undo and the outside file).
    rmSync(path.join(ws, "a.txt"));
    symlinkSync(secret, path.join(ws, "a.txt"));

    const u = await undoTool.execute({}, ctx);

    expect(u.ok).toBe(false);
    expect(u.error).toContain("denied by policy");
    expect(ctx.guardCalls[ctx.guardCalls.length - 1]?.target).toBe(secret);
    expect(readFileSync(secret, "utf8")).toBe("new\n");
  });
});

describe("hostile grep fixtures (symlink -> outside)", () => {
  test("grep on a directory symlink guards the real root and is denied by policy", async () => {
    const outside = realpathSync(tempRoot());
    writeFixture(outside, "secret.txt", "TOPSECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(outside, path.join(ws, "ssh"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await grepTool.execute({ pattern: "TOPSECRET", path: "ssh" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(r.output).not.toContain("TOPSECRET");
    expect(ctx.guardCalls[0]?.target).toBe(outside);
  });

  test("grep on a file symlink guards the real root and is denied by policy", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOPSECRET\n");
    const ws = makeWorkspace({});
    symlinkSync(secret, path.join(ws, "link.txt"));

    const ctx = mockToolContext({ cwd: ws, decision: insideOnly(realWorkspace(ws)) });
    const r = await grepTool.execute({ pattern: "TOPSECRET", path: "link.txt" }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy");
    expect(ctx.guardCalls[0]?.target).toBe(secret);
  });

  test("grep does not follow a directory symlink inside the workspace during the walk", async () => {
    const outside = realpathSync(tempRoot());
    writeFixture(outside, "secret.txt", "TOPSECRET OUTSIDE\n");
    const ws = makeWorkspace({ "inside.txt": "TOPSECRET INSIDE\n" });
    symlinkSync(outside, path.join(ws, "ssh"));

    // Force the pure-JS walker: this is the traversal that used to follow the
    // link. The guard only classifies the root, so the walk itself must skip it.
    const r = await withoutRipgrep(() => grepTool.execute({ pattern: "TOPSECRET" }, mockToolContext({ cwd: ws })));

    expect(r.ok).toBe(true);
    expect(r.output).toContain("inside.txt:1: TOPSECRET INSIDE");
    expect(r.output).not.toContain("TOPSECRET OUTSIDE");
    expect(r.output).not.toContain("secret.txt");

    // The ripgrep path (when present) uses the same real root and does not
    // follow the link either; on a host without rg this exercises the fallback
    // again and the same assertions hold.
    const viaRg = await grepTool.execute({ pattern: "TOPSECRET" }, mockToolContext({ cwd: ws }));
    expect(viaRg.ok).toBe(true);
    expect(viaRg.output).toContain("inside.txt:1: TOPSECRET INSIDE");
    expect(viaRg.output).not.toContain("TOPSECRET OUTSIDE");
    expect(viaRg.output).not.toContain("secret.txt");
  });

  test("grep does not read a file symlink inside the workspace during the walk", async () => {
    const outside = realpathSync(tempRoot());
    const secret = writeFixture(outside, "secret.txt", "TOPSECRET OUTSIDE\n");
    const ws = makeWorkspace({ "inside.txt": "TOPSECRET INSIDE\n" });
    symlinkSync(secret, path.join(ws, "leak.txt"));

    const r = await withoutRipgrep(() => grepTool.execute({ pattern: "TOPSECRET" }, mockToolContext({ cwd: ws })));

    expect(r.ok).toBe(true);
    expect(r.output).toContain("inside.txt:1: TOPSECRET INSIDE");
    expect(r.output).not.toContain("TOPSECRET OUTSIDE");
    expect(r.output).not.toContain("leak.txt");
  });
});

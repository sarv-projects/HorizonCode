/** `write` — parent creation, overwrite, counts, guard/approve paths. */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { clearLintedPaths, noteLintedPath } from "../../src/core/git-dirty-checkpoint";
import { readTool } from "../../src/tools/read";
import { writeTool } from "../../src/tools/write";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

function initGitWorkspace(): string {
  const ws = mkdtempSync(path.join(tmpdir(), "hz-write-git-"));
  spawnSync("git", ["init"], { cwd: ws });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: ws });
  spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
  return ws;
}

describe("write tool", () => {
  test("creates missing parent directories", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute({ path: "a/b/c/f.txt", content: "hi\n" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(ws, "a/b/c/f.txt"))).toBe(true);
    expect(readFixture(ws, "a/b/c/f.txt")).toBe("hi\n");
    expect(r.output).toMatch(/^Wrote 1 lines? \(3 bytes\) to a\/b\/c\/f\.txt$/);
  });

  test("overwrites an existing file (after a read, per the read-before-write gate)", async () => {
    const ws = makeWorkspace({ "f.txt": "long original content\n" });
    const ctx = mockToolContext({ cwd: ws });
    // A file this session has not read is refused (tests/tools/read-ledger.test.ts);
    // the read is the flow the gate asks for.
    expect((await readTool.execute({ path: "f.txt" }, ctx)).ok).toBe(true);
    const r = await writeTool.execute({ path: "f.txt", content: "new\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "f.txt")).toBe("new\n");
    expect(r.output).toMatch(/^Wrote 1 lines? \(4 bytes\) to f\.txt$/);
  });

  test("reports line and byte counts", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute(
      { path: "f.txt", content: "one\ntwo\nthree\n" },
      mockToolContext({ cwd: ws }),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Wrote 3 lines (14 bytes) to f.txt");
  });

  test("counts an unterminated final line", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute({ path: "f.txt", content: "one\ntwo" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Wrote 2 lines (7 bytes) to f.txt");
  });

  test("writes an empty file as zero lines", async () => {
    const ws = makeWorkspace();
    const r = await writeTool.execute({ path: "empty.txt", content: "" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("Wrote 0 lines (0 bytes) to empty.txt");
    expect(readFixture(ws, "empty.txt")).toBe("");
  });

  test("asks for approval with the path and size when the guard says ask", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: true });
    const r = await writeTool.execute({ path: "newdir/f.txt", content: "hi\nthere\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls).toEqual([{ kind: "fs.write", target: `${ws}/newdir/f.txt` }]);
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0]).toEqual({
      title: "Write newdir/f.txt",
      detail: "2 lines, 9 bytes",
      kind: "fs.write",
    });
    expect(readFixture(ws, "newdir/f.txt")).toBe("hi\nthere\n");
  });

  test("returns a declined error and writes nothing when approval is refused", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await writeTool.execute({ path: "newdir/f.txt", content: "nope\n" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).toBe("declined by user");
    expect(ctx.approveCalls.length).toBe(1);
    expect(existsSync(path.join(ws, "newdir"))).toBe(false);
  });

  test("reports a policy denial without writing", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "read-only workspace" });
    const r = await writeTool.execute({ path: "f.txt", content: "x\n" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: read-only workspace");
    expect(ctx.approveCalls.length).toBe(0);
    expect(existsSync(path.join(ws, "f.txt"))).toBe(false);
  });

  test("requires path and content", async () => {
    const ctx = mockToolContext();
    expect((await writeTool.execute({}, ctx)).error).toBe("path is required");
    expect((await writeTool.execute({ path: "f.txt" }, ctx)).error).toBe("content is required");
    expect(ctx.guardCalls.length).toBe(0);
  });

  test("E-1: opt-in lint-fix commit after successful write of a linted path", async () => {
    const prev = process.env.HZ_GIT_LINT_FIX_COMMIT;
    process.env.HZ_GIT_LINT_FIX_COMMIT = "1";
    clearLintedPaths();
    try {
      const ws = initGitWorkspace();
      const rel = "f.ts";
      writeFileSync(path.join(ws, rel), "const x = 1\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });
      const sessionId = "sess-write-lintfix";
      const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId });
      noteLintedPath(sessionId, rel);
      expect((await readTool.execute({ path: rel }, ctx)).ok).toBe(true);
      const r = await writeTool.execute({ path: rel, content: "const x = 1;\n" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain("lint-fix commit");
      const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: ws, encoding: "utf8" }).stdout;
      expect(log).toContain("lint fix");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prev;
      clearLintedPaths();
    }
  });

  test("E-1: write does not lint-fix commit when flag is off", async () => {
    const prev = process.env.HZ_GIT_LINT_FIX_COMMIT;
    delete process.env.HZ_GIT_LINT_FIX_COMMIT;
    clearLintedPaths();
    try {
      const ws = initGitWorkspace();
      const rel = "g.ts";
      writeFileSync(path.join(ws, rel), "const x = 1\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });
      const sessionId = "sess-write-off";
      const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId });
      noteLintedPath(sessionId, rel);
      expect((await readTool.execute({ path: rel }, ctx)).ok).toBe(true);
      const r = await writeTool.execute({ path: rel, content: "const x = 1;\n" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).not.toContain("lint-fix commit");
      const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: ws, encoding: "utf8" }).stdout;
      expect(log).not.toContain("lint fix");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prev;
      clearLintedPaths();
    }
  });

  test("E-1: opt-in dirty checkpoint commits pre-existing dirt before the write", async () => {
    const prev = process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = "1";
    try {
      const ws = initGitWorkspace();
      const rel = "f.txt";
      writeFileSync(path.join(ws, rel), "committed\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });

      // Uncommitted dirt that a naive overwrite would destroy.
      writeFileSync(path.join(ws, rel), "dirty draft\n");
      const ctx = mockToolContext({ cwd: ws, workspace: ws });
      expect((await readTool.execute({ path: rel }, ctx)).ok).toBe(true);
      const r = await writeTool.execute({ path: rel, content: "replacement\n" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain("checkpoint commit before editing");
      expect(readFixture(ws, rel)).toBe("replacement\n");

      const subjects = spawnSync("git", ["log", "-2", "--pretty=%s"], { cwd: ws, encoding: "utf8" }).stdout
        .trim()
        .split("\n");
      expect(subjects[0]).toContain("checkpoint before edit");
      expect(subjects[1]).toBe("init");
      // The checkpoint preserved the DIRTY pre-write content, not the replacement.
      const blob = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: ws, encoding: "utf8" }).stdout;
      expect(blob).toBe("dirty draft\n");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
      else process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = prev;
    }
  });

  test("E-1: write is a no-op for the checkpoint when the opt-in is off", async () => {
    const prev = process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    try {
      const ws = initGitWorkspace();
      const rel = "g.txt";
      writeFileSync(path.join(ws, rel), "committed\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });
      writeFileSync(path.join(ws, rel), "dirty draft\n");
      const ctx = mockToolContext({ cwd: ws, workspace: ws });
      expect((await readTool.execute({ path: rel }, ctx)).ok).toBe(true);
      const r = await writeTool.execute({ path: rel, content: "replacement\n" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).not.toContain("checkpoint commit before editing");
      expect(r.output).toBe("Wrote 1 lines (12 bytes) to g.txt");
      const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: ws, encoding: "utf8" }).stdout;
      expect(log).toContain("init");
      expect(log).not.toContain("checkpoint before edit");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
      else process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = prev;
    }
  });
});

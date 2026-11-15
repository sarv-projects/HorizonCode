import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHandoff, resetHandoffsForTests } from "../../src/core/memory/handoff";
import { handoffResumeTool } from "../../src/tools/handoff";
import { openTodos, todoTool } from "../../src/tools/todo";
import { mockToolContext } from "./helpers";

let workspace = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

function initGitRepo(dir: string, branch = "main"): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: dir, stdio: "ignore" });
  if (branch !== "main") {
    execSync(`git checkout -b ${branch}`, { cwd: dir, stdio: "ignore" });
  }
}

describe("handoff_resume todo rehydrate", () => {
  test("rehydrate_todos imports snapshotted lines into live list", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hnd-rehyd-"));
    initGitRepo(workspace);
    resetHandoffsForTests(workspace);
    createHandoff(
      workspace,
      { summary: "session end" },
      {
        continues_from: null,
        todos_snapshot: ["[t1] fix lint", "[t2] ship slice"],
      },
    );
    const ctx = mockToolContext({ cwd: workspace, sessionId: "resume-session-1" });
    expect(openTodos(ctx.sessionId)).toEqual([]);

    const out = await handoffResumeTool.execute({ rehydrate_todos: true }, ctx);
    expect(out.ok).toBe(true);
    expect(out.output).toContain("rehydrated_todos: 2 imported");
    expect(out.output).toContain("open_todos (live session list)");
    expect(openTodos(ctx.sessionId).map((t) => t.text)).toEqual(["fix lint", "ship slice"]);

    const second = await handoffResumeTool.execute({ rehydrate_todos: true }, ctx);
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("rehydrated_todos:");
    expect(openTodos(ctx.sessionId)).toHaveLength(2);
  });

  test("resume lists live todos even without rehydrate", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hnd-live-"));
    initGitRepo(workspace);
    resetHandoffsForTests(workspace);
    createHandoff(workspace, { summary: "snap only" }, { continues_from: null, todos_snapshot: ["[t9] old"] });
    const ctx = mockToolContext({ cwd: workspace, sessionId: "resume-session-2" });
    await todoTool.execute({ action: "add", text: "current work" }, ctx);

    const out = await handoffResumeTool.execute({}, ctx);
    expect(out.ok).toBe(true);
    expect(out.output).toContain("open_todos (live session list)");
    expect(out.output).toContain("[t1] current work");
    expect(out.output).toContain("snapshotted_open_todos");
    expect(openTodos(ctx.sessionId)).toHaveLength(1);
  });
});
import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { gitLogTool, gitStatusTool } from "../../src/tools/git-read";
import { makeWorkspace, mockToolContext } from "./helpers";

function initRepo(root: string): void {
  execSync("git init -q", { cwd: root });
  execSync("git config user.email test@example.com", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  execSync("git commit --allow-empty -q -m init", { cwd: root });
}

describe("git read tools", () => {
  test("git_status uses fs.read admission not shell.exec", async () => {
    const ws = makeWorkspace({ "a.txt": "hi\n" });
    initRepo(ws);
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await gitStatusTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls.length).toBe(1);
    expect(ctx.guardCalls[0]?.kind).toBe("fs.read");
    expect(ctx.guardCalls.some((a) => a.kind === "shell.exec")).toBe(false);
    expect(r.output.length).toBeGreaterThan(0);
  });

  test("git_log returns at least one commit", async () => {
    const ws = makeWorkspace();
    initRepo(ws);
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await gitLogTool.execute({ n: 5 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/init/);
  });
});
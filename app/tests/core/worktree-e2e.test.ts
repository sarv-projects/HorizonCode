/**
 * worktree e2e (docs/33 §5.12 acceptance): temp git repo, guarded add, hostile names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntime } from "../../src/core/index";
import { validateWorktreeName, worktreeAddCommand, worktreeSiblingPath } from "../../src/core/worktree";

let repo: string;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  const sibling = repo ? worktreeSiblingPath(repo, "feat") : "";
  if (sibling && existsSync(sibling)) rmSync(sibling, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

describe("worktree e2e", () => {
  test("creates sibling worktree and branch", () => {
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (gitCheck.status !== 0) return;
    repo = mkdtempSync(path.join(tmpdir(), "hz-wt-e2e-"));
    writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(git(repo, "init", "-b", "main").status).toBe(0);
    expect(git(repo, "add", "README.md").status).toBe(0);
    expect(git(repo, "commit", "-m", "init").status).toBe(0);
    const name = "feat";
    const dest = worktreeSiblingPath(repo, name);
    expect(git(repo, "worktree", "add", dest, "-b", `hz/${name}`).status).toBe(0);
    expect(existsSync(dest)).toBe(true);
    expect(git(repo, "worktree", "list").stdout).toContain(dest);
  });

  test("hostile names refused before git", () => {
    expect(validateWorktreeName("../x")).toBeDefined();
    expect(validateWorktreeName("-b evil")).toBeDefined();
    expect(validateWorktreeName("has space")).toBeDefined();
  });

  test("runGuardedShell issues a receipt for worktree add", async () => {
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (gitCheck.status !== 0) return;
    repo = mkdtempSync(path.join(tmpdir(), "hz-wt-receipt-"));
    writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(git(repo, "init", "-b", "main").status).toBe(0);
    expect(git(repo, "add", "README.md").status).toBe(0);
    expect(git(repo, "commit", "-m", "init").status).toBe(0);
    const name = "branch";
    const dest = worktreeSiblingPath(repo, name);
    const runtime = await createRuntime({ workspace: repo, mock: true });
    runtime.setApprovalHandler(async () => true);
    try {
      const out = await runtime.runGuardedShell(worktreeAddCommand(repo, name));
      expect(out.ok).toBe(true);
      expect(existsSync(dest)).toBe(true);
      const chain = await runtime.receiptChain();
      expect(chain.ok).toBe(true);
      expect(chain.count).toBeGreaterThan(0);
    } finally {
      await runtime.close();
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("worktree CLI", () => {
  test("hostile --worktree name exits 2", () => {
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (gitCheck.status !== 0) return;
    const main = path.resolve(import.meta.dir, "../../src/main.ts");
    const ws = mkdtempSync(path.join(tmpdir(), "hz-wt-cli-"));
    try {
      writeFileSync(path.join(ws, "README.md"), "# x\n");
      expect(git(ws, "init", "-b", "main").status).toBe(0);
      const r = spawnSync("bun", [main, "--worktree", "../evil", "--workspace", ws, "-p", "noop"], {
        encoding: "utf8",
        env: { ...process.env, HZ_PROVIDER: "mock" },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/invalid worktree name/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

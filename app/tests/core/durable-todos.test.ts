import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  admitDurableBranchTrackWrite,
  branchKeyForWorkspace,
  durableBranchTrackPath,
  durableTodoStorePath,
  listDurableTodoBranches,
  loadBranchTodos,
  mergeDurableBranchOpenTodos,
  maybeAutoMergeDurableOnBranchChange,
  OPEN_TODOS_FILE,
  recordLastDurableBranch,
  saveBranchTodos,
  saveBranchTodosLegacyJson,
} from "../../src/core/durable-todos";
import { stateRoot } from "../../src/core/paths";
import { hydrateTodosFromDurable, openTodos, todoTool } from "../../src/tools/todo";
import { mockToolContext } from "../tools/helpers";

let workspace = "";
const prev = process.env.HZ_TODO_DURABLE;
const prevMerge = process.env.HZ_TODO_DURABLE_AUTOMERGE;
const prevBin = process.env.HZ_KERNEL_BIN;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
  process.env.HZ_TODO_DURABLE = prev;
  if (prevMerge === undefined) delete process.env.HZ_TODO_DURABLE_AUTOMERGE;
  else process.env.HZ_TODO_DURABLE_AUTOMERGE = prevMerge;
  if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
  else process.env.HZ_KERNEL_BIN = prevBin;
});

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: dir, stdio: "ignore" });
}

describe("durable todos", () => {
  test("persists branch todos when HZ_TODO_DURABLE=1", async () => {
    process.env.HZ_TODO_DURABLE = "1";
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-"));
    initGitRepo(workspace);
    const ctx = mockToolContext({ cwd: workspace, sessionId: "dur-1" });
    await todoTool.execute({ action: "add", text: "ship durable" }, ctx);
    const fp = durableTodoStorePath(workspace);
    expect(existsSync(fp)).toBe(true);
    const branch = branchKeyForWorkspace(workspace);
    const rows = loadBranchTodos(workspace, branch);
    expect(rows.some((r) => r.text === "ship durable" && !r.done)).toBe(true);
    chmodSync(fp, 0o600);
  });

  test("migrates legacy open-todos.json into handoffs.db", () => {
    process.env.HZ_TODO_DURABLE = "1";
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-mig-"));
    initGitRepo(workspace);
    const branch = branchKeyForWorkspace(workspace);
    saveBranchTodosLegacyJson(workspace, branch, [{ id: "t9", text: "migrated row", done: false }]);
    loadBranchTodos(workspace, branch);
    expect(existsSync(path.join(stateRoot(workspace), OPEN_TODOS_FILE))).toBe(false);
    const rows = loadBranchTodos(workspace, branch);
    expect(rows).toEqual([{ id: "t9", text: "migrated row", done: false }]);
  });

  test("mergeDurableBranchOpenTodos copies open rows deduping by text", () => {
    process.env.HZ_TODO_DURABLE = "1";
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-merge-"));
    initGitRepo(workspace);
    saveBranchTodos(workspace, "feat/old", [
      { id: "t1", text: "carry me", done: false },
      { id: "t2", text: "done item", done: true },
    ]);
    saveBranchTodos(workspace, "main", [{ id: "t1", text: "carry me", done: false }]);
    const stats = mergeDurableBranchOpenTodos(workspace, "feat/old", "main");
    expect(stats.merged).toBe(0);
    expect(stats.skipped).toBe(1);
    saveBranchTodos(workspace, "main", []);
    const stats2 = mergeDurableBranchOpenTodos(workspace, "feat/old", "main");
    expect(stats2.merged).toBe(1);
    expect(stats2.skipped).toBe(0);
    const rows = loadBranchTodos(workspace, "main");
    expect(rows.some((r) => r.text === "carry me" && !r.done)).toBe(true);
    expect(rows.every((r) => r.text !== "done item" || r.done)).toBe(true);
    expect(listDurableTodoBranches(workspace).sort()).toEqual(["feat/old", "main"]);
  });

  test("maybeAutoMergeDurableOnBranchChange copies when branch changes", async () => {
    process.env.HZ_TODO_DURABLE = "1";
    process.env.HZ_TODO_DURABLE_AUTOMERGE = "1";
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-auto-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "README.md"), "durable branch test\n");
    execSync("git add README.md", { cwd: workspace, stdio: "ignore" });
    execSync('git -c user.email=t@t.com -c user.name=t commit -m init', { cwd: workspace, stdio: "ignore" });
    execSync("git checkout -b feat/carry", { cwd: workspace, stdio: "ignore" });
    saveBranchTodos(workspace, branchKeyForWorkspace(workspace), [{ id: "t1", text: "carry on branch", done: false }]);
    execSync("git checkout main", { cwd: workspace, stdio: "ignore" });
    const auto = await maybeAutoMergeDurableOnBranchChange(workspace);
    expect(auto.merged).toBe(1);
    expect(auto.fromBranch).toBe("feat/carry");
    const mainBranch = branchKeyForWorkspace(workspace);
    expect(loadBranchTodos(workspace, mainBranch).some((r) => r.text === "carry on branch")).toBe(true);
  });

  test("admitDurableBranchTrackWrite refuses deny before persist (ruling 599)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-deny-"));
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    const kernelState = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(kernelState, { recursive: true });
    writeFileSync(
      path.join(kernelState, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-branch-track" }]),
      "utf8",
    );
    const refused = await admitDurableBranchTrackWrite(workspace);
    expect(refused).toMatch(/denied|test-deny-branch-track|durable-todo-branch/i);
    const writeRefused = await recordLastDurableBranch(workspace, "main");
    expect(writeRefused).toMatch(/denied|test-deny-branch-track|durable-todo-branch/i);
    expect(existsSync(durableBranchTrackPath(workspace))).toBe(false);
  }, 20_000);

  test("hydrates empty session from handoffs.db", async () => {
    process.env.HZ_TODO_DURABLE = "1";
    workspace = mkdtempSync(path.join(tmpdir(), "hz-dtodo-hy-"));
    initGitRepo(workspace);
    const branch = branchKeyForWorkspace(workspace);
    saveBranchTodos(workspace, branch, [{ id: "t1", text: "from file", done: false }]);
    const open = hydrateTodosFromDurable(workspace, "sess-new");
    expect(open).toBe(1);
    expect(openTodos("sess-new").map((t) => t.text)).toEqual(["from file"]);
  });
});
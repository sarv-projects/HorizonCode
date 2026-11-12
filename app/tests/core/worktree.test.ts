import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { validateWorktreeName, worktreeAddCommand, worktreeSiblingPath } from "../../src/core/worktree";

describe("worktree naming", () => {
  test("hostile names are refused", () => {
    expect(validateWorktreeName("../x")).toBeDefined();
    expect(validateWorktreeName("-b")).toBeDefined();
    expect(validateWorktreeName("has space")).toBeDefined();
    expect(validateWorktreeName("")).toBeDefined();
  });

  test("sibling path and git command shape", () => {
    const repo = path.resolve("/tmp/myrepo");
    expect(worktreeSiblingPath(repo, "feat")).toBe(path.resolve("/tmp", "myrepo-feat"));
    const cmd = worktreeAddCommand(repo, "feat");
    expect(cmd).toContain("git worktree add");
    expect(cmd).toContain("hz/feat");
  });
});

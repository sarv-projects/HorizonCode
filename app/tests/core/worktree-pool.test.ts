import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  inspectWorktreePool,
  parseGitWorktreePorcelain,
  resolveWorktreeAcquire,
  siblingWorktreeName,
  worktreePoolMaxFromEnv,
} from "../../src/core/worktree-pool";
import { worktreeSiblingPath } from "../../src/core/worktree";

const PORCELAIN = `
worktree /tmp/myrepo
HEAD abc1111111111111111111111111111111111
branch refs/heads/main

worktree /tmp/myrepo-feat
HEAD def2222222222222222222222222222222222
branch refs/heads/hz/feat

worktree /tmp/other-clone
HEAD aaa3333333333333333333333333333333333
branch refs/heads/main
`.trim();

describe("worktree pool", () => {
  test("parses porcelain", () => {
    const rows = parseGitWorktreePorcelain(PORCELAIN);
    expect(rows.length).toBe(3);
    expect(rows[1]?.branch).toBe("hz/feat");
  });

  test("sibling name round-trip", () => {
    const repo = path.resolve("/tmp/myrepo");
    const dest = worktreeSiblingPath(repo, "feat");
    expect(siblingWorktreeName(repo, dest)).toBe("feat");
  });

  test("inspect counts hz pool siblings", () => {
    const status = inspectWorktreePool("/tmp/myrepo", { max: 8, porcelain: PORCELAIN });
    expect(status.poolCount).toBe(1);
    expect(status.entries.some((e) => e.name === "feat")).toBe(true);
  });

  test("reuse when worktree already registered", () => {
    const repo = path.resolve("/tmp/myrepo");
    const d = resolveWorktreeAcquire(repo, "feat", { max: 8, porcelain: PORCELAIN });
    expect(d.kind).toBe("reuse");
    if (d.kind === "reuse") expect(d.dest).toBe(worktreeSiblingPath(repo, "feat"));
  });

  test("refuse at capacity for new name", () => {
    const repo = path.resolve("/tmp/myrepo");
    const d = resolveWorktreeAcquire(repo, "newtree", { max: 1, porcelain: PORCELAIN, destExists: false });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toContain("pool full");
  });

  test("HZ_WORKTREE_POOL_MAX env", () => {
    expect(worktreePoolMaxFromEnv({ HZ_WORKTREE_POOL_MAX: "3" })).toBe(3);
    expect(worktreePoolMaxFromEnv({ HZ_WORKTREE_POOL_MAX: "nope" })).toBe(8);
  });
});

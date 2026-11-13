import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkpointDirtyPathBeforeEdit, dirtyCommitBeforeEditEnabled } from "../../src/core/git-dirty-checkpoint";

describe("dirty commit before edit (E-1 reduced)", () => {
  test("off by default", () => {
    expect(dirtyCommitBeforeEditEnabled({})).toBe(false);
    expect(dirtyCommitBeforeEditEnabled({ HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT: "1" })).toBe(true);
  });

  test("commits dirty file when enabled", () => {
    const prev = process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = "1";
    try {
      const ws = mkdtempSync(join(tmpdir(), "hz-git-"));
      spawnSync("git", ["init"], { cwd: ws });
      const rel = "f.txt";
      writeFileSync(join(ws, rel), "one\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      writeFileSync(join(ws, rel), "two\n");
      const cp = checkpointDirtyPathBeforeEdit(ws, rel);
      expect(cp.committed).toBe(true);
      const log = spawnSync("git", ["log", "-1", "--oneline"], { cwd: ws, encoding: "utf8" });
      expect(log.stdout).toContain("checkpoint before edit");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
      else process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = prev;
    }
  });
});

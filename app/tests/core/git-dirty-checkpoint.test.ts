import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkpointDirtyPathBeforeEdit,
  clearLintedPaths,
  commitLintFixPathAfterEdit,
  dirtyCommitBeforeEditEnabled,
  formatLintFixCommitSuffix,
  formatLintFixCommitSuffixes,
  lintFixCommitEnabled,
  noteLintedPath,
  wasLintedPath,
} from "../../src/core/git-dirty-checkpoint";

function initRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "hz-git-"));
  spawnSync("git", ["init"], { cwd: ws });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: ws });
  spawnSync("git", ["config", "user.name", "t"], { cwd: ws });
  return ws;
}

function gitLogOneline(ws: string, n = 5): string {
  return spawnSync("git", ["log", `-${n}`, "--oneline"], { cwd: ws, encoding: "utf8" }).stdout;
}

describe("dirty commit before edit (E-1 default-on)", () => {
  test("on by default; 0 opts out", () => {
    expect(dirtyCommitBeforeEditEnabled({})).toBe(true);
    expect(dirtyCommitBeforeEditEnabled({ HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT: "1" })).toBe(true);
    expect(dirtyCommitBeforeEditEnabled({ HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT: "0" })).toBe(false);
  });

  test("commits dirty file when enabled", () => {
    const prev = process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = "1";
    try {
      const ws = initRepo();
      const rel = "f.txt";
      writeFileSync(join(ws, rel), "one\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "init"], {
        cwd: ws,
      });
      writeFileSync(join(ws, rel), "two\n");
      const cp = checkpointDirtyPathBeforeEdit(ws, rel);
      expect(cp.committed).toBe(true);
      expect(gitLogOneline(ws, 1)).toContain("checkpoint before edit");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
      else process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = prev;
    }
  });
});

describe("lint-fix commit separation (E-1 residual)", () => {
  test("off by default", () => {
    expect(lintFixCommitEnabled({})).toBe(false);
    expect(lintFixCommitEnabled({ HZ_GIT_LINT_FIX_COMMIT: "1" })).toBe(true);
  });

  test("skips when path was not linted", () => {
    const prev = process.env.HZ_GIT_LINT_FIX_COMMIT;
    process.env.HZ_GIT_LINT_FIX_COMMIT = "1";
    clearLintedPaths();
    try {
      const ws = initRepo();
      const rel = "a.ts";
      writeFileSync(join(ws, rel), "const x = 1\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });
      writeFileSync(join(ws, rel), "const x = 1;\n");
      const r = commitLintFixPathAfterEdit("sess-none", ws, rel);
      expect(r.attempted).toBe(false);
      expect(r.committed).toBe(false);
      expect(gitLogOneline(ws, 1)).not.toContain("lint fix");
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prev;
      clearLintedPaths();
    }
  });

  test("commits dirty path after lint marker with distinct message", () => {
    const prev = process.env.HZ_GIT_LINT_FIX_COMMIT;
    process.env.HZ_GIT_LINT_FIX_COMMIT = "1";
    clearLintedPaths();
    try {
      const ws = initRepo();
      const rel = "b.ts";
      const session = "sess-lint";
      writeFileSync(join(ws, rel), "const x = 1\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });

      noteLintedPath(session, rel);
      expect(wasLintedPath(session, rel)).toBe(true);

      writeFileSync(join(ws, rel), "const x = 1;\n");
      const r = commitLintFixPathAfterEdit(session, ws, rel);
      expect(r.committed).toBe(true);
      expect(r.notice).toContain("lint-fix commit");
      expect(gitLogOneline(ws, 1)).toContain("lint fix");
      expect(wasLintedPath(session, rel)).toBe(false);

      // marker consumed — second call does not commit again
      writeFileSync(join(ws, rel), "const x = 2;\n");
      const r2 = commitLintFixPathAfterEdit(session, ws, rel);
      expect(r2.attempted).toBe(false);
      expect(r2.committed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prev;
      clearLintedPaths();
    }
  });

  test("checkpoint then lint-fix stay independently revertible", () => {
    const prevDirty = process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
    const prevLint = process.env.HZ_GIT_LINT_FIX_COMMIT;
    process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = "1";
    process.env.HZ_GIT_LINT_FIX_COMMIT = "1";
    clearLintedPaths();
    try {
      const ws = initRepo();
      const rel = "c.ts";
      const session = "sess-both";
      writeFileSync(join(ws, rel), "feature\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });

      // uncommitted feature dirt
      writeFileSync(join(ws, rel), "feature v2\n");
      const cp = checkpointDirtyPathBeforeEdit(ws, rel);
      expect(cp.committed).toBe(true);

      noteLintedPath(session, rel);
      // post-lint edit (lint fix dirt)
      writeFileSync(join(ws, rel), "feature v2;\n");
      const lf = commitLintFixPathAfterEdit(session, ws, rel);
      expect(lf.committed).toBe(true);

      const log = gitLogOneline(ws, 3);
      expect(log).toContain("lint fix");
      expect(log).toContain("checkpoint before edit");
      // two distinct commits on top of init
      const subjects = spawnSync("git", ["log", "-2", "--pretty=%s"], { cwd: ws, encoding: "utf8" }).stdout
        .trim()
        .split("\n");
      expect(subjects[0]).toContain("lint fix");
      expect(subjects[1]).toContain("checkpoint before edit");
    } finally {
      if (prevDirty === undefined) delete process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT;
      else process.env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT = prevDirty;
      if (prevLint === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prevLint;
      clearLintedPaths();
    }
  });

  test("formatLintFixCommitSuffix / Suffixes notice after mutation", () => {
    const prev = process.env.HZ_GIT_LINT_FIX_COMMIT;
    process.env.HZ_GIT_LINT_FIX_COMMIT = "1";
    clearLintedPaths();
    try {
      const ws = initRepo();
      const rel = "d.ts";
      const session = "sess-fmt";
      writeFileSync(join(ws, rel), "const x = 1\n");
      spawnSync("git", ["add", rel], { cwd: ws });
      spawnSync("git", ["commit", "-m", "init"], { cwd: ws });
      noteLintedPath(session, rel);
      writeFileSync(join(ws, rel), "const x = 1;\n");
      const note = formatLintFixCommitSuffix(session, ws, rel);
      expect(note).toContain("lint-fix commit");
      expect(gitLogOneline(ws, 1)).toContain("lint fix");

      // multi-path helper dedupes and skips unmarked paths
      writeFileSync(join(ws, "e.ts"), "y\n");
      spawnSync("git", ["add", "e.ts"], { cwd: ws });
      spawnSync("git", ["commit", "-m", "add e"], { cwd: ws });
      noteLintedPath(session, "e.ts");
      writeFileSync(join(ws, "e.ts"), "y;\n");
      const multi = formatLintFixCommitSuffixes(session, ws, ["e.ts", "e.ts", "missing.ts"]);
      expect(multi).toContain("lint-fix commit");
      expect(multi.split("lint-fix commit").length - 1).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.HZ_GIT_LINT_FIX_COMMIT;
      else process.env.HZ_GIT_LINT_FIX_COMMIT = prev;
      clearLintedPaths();
    }
  });
});

/**
 * E-1 reduced (docs/30): optional dirty checkpoint commit before a file edit
 * (opt-in via `HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT=1`). ADAPT aider
 * `need_commit_before_edits` — one file at a time, harness-initiated.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { insideGitRepo } from "./prompt/environment";

export function dirtyCommitBeforeEditEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT === "1";
}

export interface DirtyCheckpointResult {
  attempted: boolean;
  committed: boolean;
  notice?: string;
  error?: string;
}

/** Stage and commit `relPath` when it has unstaged or staged dirt (best effort). */
export function checkpointDirtyPathBeforeEdit(workspace: string, relPath: string): DirtyCheckpointResult {
  if (!dirtyCommitBeforeEditEnabled()) return { attempted: false, committed: false };
  if (!insideGitRepo(workspace)) return { attempted: false, committed: false };
  const rel = relPath.replace(/^\.\//, "");
  if (rel === "" || rel === ".") return { attempted: false, committed: false };

  const diff = spawnSync("git", ["diff", "--quiet", "--", rel], { cwd: workspace, encoding: "utf8" });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", rel], { cwd: workspace, encoding: "utf8" });
  const dirty = diff.status !== 0 || staged.status !== 0;
  if (!dirty) return { attempted: true, committed: false };

  const add = spawnSync("git", ["add", "--", rel], { cwd: workspace, encoding: "utf8" });
  if (add.status !== 0) {
    return {
      attempted: true,
      committed: false,
      error: (add.stderr || "git add failed").trim(),
    };
  }
  const message = `hz: checkpoint before edit (${rel})`;
  const commit = spawnSync("git", ["commit", "-m", message, "--", rel], { cwd: workspace, encoding: "utf8" });
  if (commit.status !== 0) {
    return {
      attempted: true,
      committed: false,
      error: (commit.stderr || "git commit failed").trim(),
    };
  }
  return {
    attempted: true,
    committed: true,
    notice: `[git: checkpoint commit before editing ${rel}]`,
  };
}

export function resolveRelativePath(workspace: string, cwd: string, target: string): string {
  return path.relative(workspace, path.resolve(cwd, target)).replace(/\\/g, "/");
}

/**
 * E-1 reduced (docs/30): optional dirty checkpoint commit before a file edit
 * (opt-in via `HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT=1`), plus a separate lint-fix
 * commit after a successful mutation (`edit` / `write` / `apply_patch`) that
 * follows `lint` on the same path (`HZ_GIT_LINT_FIX_COMMIT=1`). ADAPT aider
 * `need_commit_before_edits` / post-`lint_edited` second commit — one file at
 * a time, harness-initiated. Default-off; never auto-commit without the flag.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { insideGitRepo } from "./prompt/environment";

export function dirtyCommitBeforeEditEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT === "1";
}

/** Opt-in: commit post-edit dirt as an independently revertible lint-fix unit. */
export function lintFixCommitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HZ_GIT_LINT_FIX_COMMIT === "1";
}

export interface DirtyCheckpointResult {
  attempted: boolean;
  committed: boolean;
  notice?: string;
  error?: string;
}

/** Paths the session recently linted; an ensuing edit may become a lint-fix commit. */
const lintedPathsBySession = new Map<string, Set<string>>();

function normalizeRel(relPath: string): string {
  return relPath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Record that `lint` inspected `relPath` in this session (best-effort marker). */
export function noteLintedPath(sessionId: string, relPath: string): void {
  const rel = normalizeRel(relPath);
  if (rel === "" || rel === ".") return;
  let set = lintedPathsBySession.get(sessionId);
  if (set === undefined) {
    set = new Set();
    lintedPathsBySession.set(sessionId, set);
  }
  set.add(rel);
}

/** @internal test hook */
export function clearLintedPaths(sessionId?: string): void {
  if (sessionId === undefined) lintedPathsBySession.clear();
  else lintedPathsBySession.delete(sessionId);
}

export function wasLintedPath(sessionId: string, relPath: string): boolean {
  return lintedPathsBySession.get(sessionId)?.has(normalizeRel(relPath)) ?? false;
}

function commitDirtyRelPath(
  workspace: string,
  relPath: string,
  message: string,
  notice: string,
): DirtyCheckpointResult {
  if (!insideGitRepo(workspace)) return { attempted: false, committed: false };
  const rel = normalizeRel(relPath);
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
    notice,
  };
}

/** Stage and commit `relPath` when it has unstaged or staged dirt (best effort). */
export function checkpointDirtyPathBeforeEdit(workspace: string, relPath: string): DirtyCheckpointResult {
  if (!dirtyCommitBeforeEditEnabled()) return { attempted: false, committed: false };
  const rel = normalizeRel(relPath);
  return commitDirtyRelPath(
    workspace,
    rel,
    `hz: checkpoint before edit (${rel})`,
    `[git: checkpoint commit before editing ${rel}]`,
  );
}

/**
 * After a successful mutation of a path previously noted by `lint`, stage and
 * commit that path as a lint-fix unit (best effort). Consumes the lint marker
 * on attempt. Call sites: `edit`, `write`, `apply_patch` (when flag is on).
 */
export function commitLintFixPathAfterEdit(
  sessionId: string,
  workspace: string,
  relPath: string,
): DirtyCheckpointResult {
  if (!lintFixCommitEnabled()) return { attempted: false, committed: false };
  const rel = normalizeRel(relPath);
  const set = lintedPathsBySession.get(sessionId);
  if (set === undefined || !set.has(rel)) return { attempted: false, committed: false };
  set.delete(rel);
  if (set.size === 0) lintedPathsBySession.delete(sessionId);

  return commitDirtyRelPath(workspace, rel, `hz: lint fix (${rel})`, `[git: lint-fix commit for ${rel}]`);
}

/** Tool-output suffix when a lint-fix commit fires (or fails) after a mutation. */
export function formatLintFixCommitSuffix(
  sessionId: string,
  workspace: string,
  relPath: string,
): string {
  const lf = commitLintFixPathAfterEdit(sessionId, workspace, relPath);
  if (lf.committed && lf.notice) return `\n${lf.notice}`;
  if (lf.error) return `\n[git lint-fix commit failed: ${lf.error}]`;
  return "";
}

/** Apply lint-fix commit attempts for each mutated path; concatenate notices. */
export function formatLintFixCommitSuffixes(
  sessionId: string,
  workspace: string,
  relPaths: readonly string[],
): string {
  let out = "";
  const seen = new Set<string>();
  for (const relPath of relPaths) {
    const rel = normalizeRel(relPath);
    if (rel === "" || rel === "." || seen.has(rel)) continue;
    seen.add(rel);
    out += formatLintFixCommitSuffix(sessionId, workspace, rel);
  }
  return out;
}

export function resolveRelativePath(workspace: string, cwd: string, target: string): string {
  return path.relative(workspace, path.resolve(cwd, target)).replace(/\\/g, "/");
}

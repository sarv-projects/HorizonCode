/**
 * ignore.ts — the one place that answers "would git ignore this path?".
 *
 * grep has always obeyed ignore rules inside a git repository (ripgrep reads
 * `.gitignore` by default), but glob happily listed the same paths, and grep's
 * own JS fallback never filtered them either — the two tools disagreed about
 * what the repository contains. This helper asks git itself, in one batch call
 * per listing, so the answer is git's own semantics rather than a
 * re-implementation of pattern matching.
 *
 * Fail-open by construction: outside a git repository (exit 128), without git
 * on PATH, or on any spawn/read failure, nothing is filtered and every caller
 * behaves exactly as it did before this module existed. A missing filter costs
 * visible noise; a wrong filter would hide real files, which is worse.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";

/** Is `dir` (or an ancestor) inside a git worktree? Cheap, no spawn. */
function inGitWorktree(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function gitIgnoredPaths(
  cwd: string,
  absolutePaths: readonly string[],
  stateDir: string,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (absolutePaths.length === 0) return ignored;
  // Outside a worktree `check-ignore` exits 128 without reading stdin, and the
  // write below would race that exit (an EPIPE in whatever async context the
  // caller is in — it surfaced as a flaky, unrelated test failure). Skip the
  // spawn entirely: no worktree, no ignore rules, no filter.
  if (!inGitWorktree(cwd)) return ignored;
  try {
    const { proc } = await spawnOwned(["git", "-C", cwd, "check-ignore", "--no-index", "-z", "--stdin"], {
      stateDir,
      label: "ignore:check",
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      longLived: false,
    });
    const stdin = proc.stdin as {
      write(data: string): void;
      end(): void;
      on?: (event: string, listener: () => void) => void;
    };
    // Swallow the write-side error: if the pipe closes under us the exit code
    // below is still the answer, and an EPIPE must not escape as an uncaught
    // exception in the caller's context.
    stdin.on?.("error", () => undefined);
    try {
      stdin.write(absolutePaths.join("\0"));
      stdin.end();
    } catch {
      /* the pipe closed early; proc.exited still reports what happened */
    }
    const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const code = await proc.exited;
    // 0 = some paths are ignored (their names are on stdout, NUL-separated),
    // 1 = none are, 128 = not a git repository — all three are answers, not
    // errors. Anything else is a failure we refuse to guess about: no filter.
    if (code === 0) {
      for (const path of out.split("\0")) if (path !== "") ignored.add(path);
    }
  } catch {
    /* no git, no repository, no filter — see the header */
  }
  return ignored;
}

/** Convenience: the same filter, scoped to one caller's workspace. */
export async function gitIgnoredPathsFor(
  cwd: string,
  workspace: string,
  absolutePaths: readonly string[],
): Promise<Set<string>> {
  return gitIgnoredPaths(cwd, absolutePaths, kernelStateDir(workspace));
}

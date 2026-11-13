/**
 * /worktree — list the process-local hz sibling pool (docs/12 F11 reduced).
 */

import { spawnSync } from "node:child_process";
import type { Renderer } from "./render";
import {
  formatWorktreePoolLines,
  inspectWorktreePool,
  worktreePoolMaxFromEnv,
} from "../core/worktree-pool";

function gitPorcelain(cwd: string): string | undefined {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return r.stdout ?? "";
}

/** Print pool status for the runtime workspace. */
export function runWorktreeSlash(workspace: string, renderer: Renderer): void {
  const porcelain = gitPorcelain(workspace);
  if (porcelain === undefined) {
    renderer.notice("worktree pool: not inside a git repository (or git worktree list failed)");
    return;
  }
  const status = inspectWorktreePool(workspace, {
    max: worktreePoolMaxFromEnv(process.env),
    porcelain,
  });
  for (const line of formatWorktreePoolLines(status)) renderer.line(line);
}

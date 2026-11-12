/**
 * worktree.ts — `hzcode --worktree` (forgecode T-15, docs/33 §5.12).
 *
 * Creates a sibling git worktree and branch; the effect runs through the guard.
 * This is isolation of changes, not OS sandbox confinement.
 */

import * as path from "node:path";
import { shellQuote } from "./commit";

/** Refuse names that could escape the sibling naming scheme or confuse git. */
export function validateWorktreeName(name: string): string | undefined {
  const n = name.trim();
  if (n === "") return "worktree name is required";
  if (n.includes("/") || n.includes("\\") || n.includes("..")) return `invalid worktree name ${JSON.stringify(name)}`;
  if (n.startsWith("-")) return `invalid worktree name ${JSON.stringify(name)}`;
  if (/\s/.test(n)) return `invalid worktree name ${JSON.stringify(name)}`;
  return undefined;
}

/** `../<repoBasename>-<name>` beside the repository root. */
export function worktreeSiblingPath(repoRoot: string, name: string): string {
  const base = path.basename(path.resolve(repoRoot)) || "repo";
  return path.resolve(repoRoot, "..", `${base}-${name.trim()}`);
}

/** Guarded shell command: new worktree + branch `hz/<name>`. */
export function worktreeAddCommand(repoRoot: string, name: string): string {
  const dest = worktreeSiblingPath(repoRoot, name);
  const branch = `hz/${name.trim()}`;
  return `git worktree add ${shellQuote(dest)} -b ${shellQuote(branch)}`;
}

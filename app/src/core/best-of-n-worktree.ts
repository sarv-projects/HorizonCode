/**
 * Best-of-N worktree provision + teardown (extends pool planner in `best-of-n.ts`).
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ToolContext } from "../contracts";
import { shellTool } from "../tools/shell";
import type { BestOfNAttempt, BestOfNWorktreeSlot } from "./best-of-n";
import { resolveWorktreeAcquire } from "./worktree-pool";
import { worktreeRemoveCommand } from "./worktree";

export type BestOfNWorktreeShellResult = { ok: boolean; output: string };

export type BestOfNWorktreeShell = (command: string) => Promise<BestOfNWorktreeShellResult>;

export type BestOfNWorktreeRaceHooks = {
  shell: BestOfNWorktreeShell;
  /** Re-read `git worktree list --porcelain` after each add (live races). */
  refreshPorcelain?: () => string | undefined;
  /** Remove sibling trees created for this race but not selected (default true). */
  cleanupLosers?: boolean;
};

export type BestOfNWorktreeProvision = "add" | "reuse";

export function gitWorktreePorcelain(cwd: string): string | undefined {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return r.stdout ?? "";
}

/** Shell via guarded `shell` tool (`danger-full-access` for sibling `git worktree` ops). */
export function createBestOfNWorktreeShellFromCtx(ctx: ToolContext): BestOfNWorktreeShell {
  return async (command: string) => {
    const shell = shellTool;
    if (!shell) return { ok: false, output: "the shell tool is not available" };
    const child = await shell.execute(
      { command },
      { ...ctx, sandboxMode: "danger-full-access" as const },
    );
    const output = child.ok
      ? child.output
      : `${child.error ?? "failed"}\n${child.output ?? ""}`.trim();
    return { ok: child.ok, output };
  };
}

export function defaultBestOfNWorktreeHooks(ctx: ToolContext, repoRoot: string): BestOfNWorktreeRaceHooks {
  const resolved = path.resolve(repoRoot);
  return {
    shell: createBestOfNWorktreeShellFromCtx(ctx),
    refreshPorcelain: () => gitWorktreePorcelain(resolved),
    cleanupLosers: true,
  };
}

export type BestOfNPreparedSlot = BestOfNWorktreeSlot & {
  provision?: BestOfNWorktreeProvision;
};

export async function prepareBestOfNWorktreeSlots(
  repoRoot: string,
  slots: readonly BestOfNWorktreeSlot[],
  hooks: BestOfNWorktreeRaceHooks,
  pool: { max?: number; destExists?: (dest: string) => boolean } = {},
): Promise<BestOfNPreparedSlot[]> {
  const prepared: BestOfNPreparedSlot[] = [];
  let porcelain = hooks.refreshPorcelain?.() ?? "";
  for (const slot of slots) {
    let decision = slot.decision;
    if (hooks.refreshPorcelain) {
      const fresh = resolveWorktreeAcquire(repoRoot, slot.name, {
        max: pool.max,
        porcelain,
        destExists: pool.destExists ? pool.destExists(slot.path) : undefined,
      });
      decision = fresh;
    }
    if (decision.kind === "refuse") {
      prepared.push({ ...slot, decision, provision: undefined });
      continue;
    }
    if (decision.kind === "reuse") {
      prepared.push({ ...slot, decision, provision: "reuse" });
      continue;
    }
    const out = await hooks.shell(decision.command);
    if (!out.ok) {
      prepared.push({
        ...slot,
        decision: { kind: "refuse", reason: out.output.trim() || `worktree add failed for ${decision.dest}` },
        provision: undefined,
      });
      continue;
    }
    prepared.push({ ...slot, decision, provision: "add" });
    if (hooks.refreshPorcelain) {
      porcelain = hooks.refreshPorcelain() ?? porcelain;
    }
  }
  return prepared;
}

export async function cleanupBestOfNLoserWorktrees(
  attempts: readonly BestOfNAttempt[],
  winner: BestOfNAttempt | undefined,
  hooks: BestOfNWorktreeRaceHooks,
  provisionBySlot: ReadonlyMap<number, BestOfNWorktreeProvision | undefined>,
): Promise<string[]> {
  if (hooks.cleanupLosers === false) return [];
  const notes: string[] = [];
  const winnerSlot = winner?.slot;
  for (const attempt of attempts) {
    if (attempt.slot === winnerSlot) continue;
    if (provisionBySlot.get(attempt.slot) !== "add") continue;
    if (attempt.decision.kind === "refuse") continue;
    const dest = attempt.worktreePath;
    const out = await hooks.shell(worktreeRemoveCommand(dest));
    if (out.ok) {
      notes.push(`removed loser worktree ${dest}`);
    } else {
      notes.push(`loser worktree remove failed ${dest}: ${out.output.trim()}`);
    }
  }
  return notes;
}
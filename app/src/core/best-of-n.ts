/**
 * Minimal Best-of-N race across hz worktree slots (docs/12 F11 reduced).
 *
 * Plans pool slots via `worktree-pool`. Sequential mode stops at first success;
 * parallel mode (`HZ_BEST_OF_N_PARALLEL=1` or `parallel: true`) runs all slots
 * and scores. Each attempt invokes an injected runner — typically nested
 * `DelegateRunner` / `runTurn` with `opts.workspace` on the slot path.
 *
 * With `worktreeHooks`, provisions siblings via guarded `git worktree` and
 * removes loser trees created for this race after selection.
 */

import type { ToolResult } from "../contracts";
import type { WorktreeAcquireDecision } from "./worktree-pool";
import type { BestOfNWorktreeProvision, BestOfNWorktreeRaceHooks } from "./best-of-n-worktree";
import {
  cleanupBestOfNLoserWorktrees,
  prepareBestOfNWorktreeSlots,
} from "./best-of-n-worktree";
import { resolveWorktreeAcquire, worktreePoolMaxFromEnv } from "./worktree-pool";
import { worktreeSiblingPath } from "./worktree";

export const BEST_OF_N_DEFAULT = 2;
export const BEST_OF_N_MAX = 4;

export type BestOfNExitClass = "succeeded" | "unknown" | "failed";

const EXIT_RANK: Record<BestOfNExitClass, number> = {
  succeeded: 3,
  unknown: 2,
  failed: 1,
};

export function bestOfNCountFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HZ_BEST_OF_N?.trim();
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 0;
  return clampBestOfN(n);
}

/** Racing is opt-in: unset/invalid `HZ_BEST_OF_N` means disabled (fail-closed). */
export function bestOfNRacingEnabledFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return bestOfNCountFromEnv(env) > 0;
}

export function bestOfNParallelFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_BEST_OF_N_PARALLEL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveBestOfNAttemptCount(
  argsN: unknown,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  if (!bestOfNRacingEnabledFromEnv(env)) return undefined;
  if (argsN !== undefined) return clampBestOfN(argsN);
  const fromEnv = bestOfNCountFromEnv(env);
  return fromEnv > 0 ? fromEnv : undefined;
}

export function hermeticBestOfNSelfCheck(): { ok: boolean; summary: string } {
  const slots = planBestOfNWorktrees("/tmp/hermetic-bon-repo", 2, "doc", {
    max: 4,
    porcelain: `worktree /tmp/hermetic-bon-repo\nHEAD abc\nbranch refs/heads/main\n`,
    destExists: () => false,
  });
  if (slots.length !== 2 || slots[0]?.name === slots[1]?.name) {
    return { ok: false, summary: "worktree slot planner failed" };
  }
  return { ok: true, summary: "worktree slot planner hermetic ok" };
}

export function clampBestOfN(n: unknown, fallback = BEST_OF_N_DEFAULT): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  if (v < 1) return 1;
  return Math.min(BEST_OF_N_MAX, v);
}

export function classifyBestOfNExit(result: ToolResult & { exitClass?: BestOfNExitClass }): BestOfNExitClass {
  if (result.exitClass === "succeeded" || result.exitClass === "unknown" || result.exitClass === "failed") {
    return result.exitClass;
  }
  if (result.ok) return "succeeded";
  const out = result.output.trim();
  const err = (result.error ?? "").trim();
  if (out !== "" && err === "") return "unknown";
  return "failed";
}

export type BestOfNRunnerResult = ToolResult & {
  exitClass?: BestOfNExitClass;
  verifiedCommand?: string;
};

export type BestOfNRunner = (slot: {
  slot: number;
  task: string;
  worktreeName: string;
  worktreePath: string;
  profile?: string;
  maxSteps?: number;
}) => Promise<BestOfNRunnerResult>;

export type BestOfNWorktreeSlot = {
  slot: number;
  name: string;
  path: string;
  decision: WorktreeAcquireDecision;
};

export function planBestOfNWorktrees(
  repoRoot: string,
  n: number,
  nameStem: string,
  opts: {
    max?: number;
    porcelain?: string;
    destExists?: (dest: string) => boolean;
  } = {},
): BestOfNWorktreeSlot[] {
  const count = clampBestOfN(n);
  const max = opts.max ?? worktreePoolMaxFromEnv();
  const stem = sanitizeWorktreeStem(nameStem);
  const slots: BestOfNWorktreeSlot[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const name = `${stem}-${slot + 1}`;
    const path = worktreeSiblingPath(repoRoot, name);
    const decision = resolveWorktreeAcquire(repoRoot, name, {
      max,
      porcelain: opts.porcelain,
      destExists: opts.destExists ? opts.destExists(path) : undefined,
    });
    slots.push({ slot, name, path, decision });
  }
  return slots;
}

function sanitizeWorktreeStem(raw: string): string {
  const t = raw.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+/, "");
  const stem = (t === "" ? "bon" : t).slice(0, 24);
  return stem.startsWith("bon") ? stem : `bon-${stem}`;
}

export type BestOfNAttempt = {
  slot: number;
  worktreeName: string;
  worktreePath: string;
  decision: WorktreeAcquireDecision;
  result: BestOfNRunnerResult;
  exitClass: BestOfNExitClass;
  verifiedCommand?: string;
};

export function scoreBestOfNAttempt(a: BestOfNAttempt): number {
  let score = EXIT_RANK[a.exitClass] * 1000;
  if (a.verifiedCommand !== undefined && a.verifiedCommand.trim() !== "") score += 100;
  if (a.result.ok) score += 10;
  return score;
}

export function pickBestOfNAttempt(attempts: readonly BestOfNAttempt[]): BestOfNAttempt | undefined {
  if (attempts.length === 0) return undefined;
  const successes = attempts.filter((a) => a.exitClass === "succeeded");
  if (successes.length > 0) {
    return [...successes].sort((a, b) => a.slot - b.slot)[0];
  }
  return [...attempts].sort((a, b) => {
    const d = scoreBestOfNAttempt(b) - scoreBestOfNAttempt(a);
    return d !== 0 ? d : a.slot - b.slot;
  })[0];
}

export type BestOfNRaceResult = {
  winner: BestOfNAttempt | undefined;
  attempts: BestOfNAttempt[];
  n: number;
  parallel: boolean;
  /** Non-fatal teardown notes when `worktreeHooks` provisioned trees. */
  cleanupNotes?: string[];
};

export type BestOfNRaceOptions = {
  repoRoot: string;
  task: string;
  n?: number;
  /** Used to derive unique worktree names (`bon-<stem>-<slot>`). */
  nameStem?: string;
  runner: BestOfNRunner;
  parallel?: boolean;
  profile?: string;
  maxSteps?: number;
  pool?: {
    max?: number;
    porcelain?: string;
    destExists?: (dest: string) => boolean;
  };
  /** Live git worktree add/remove around the race (best_of_n / agent profile=code). */
  worktreeHooks?: BestOfNWorktreeRaceHooks;
};

async function runOneAttempt(
  slot: BestOfNWorktreeSlot,
  opts: Pick<BestOfNRaceOptions, "task" | "runner" | "profile" | "maxSteps">,
): Promise<BestOfNAttempt> {
  if (slot.decision.kind === "refuse") {
    return {
      slot: slot.slot,
      worktreeName: slot.name,
      worktreePath: slot.path,
      decision: slot.decision,
      result: { ok: false, output: "", error: slot.decision.reason },
      exitClass: "failed",
    };
  }
  const result = await opts.runner({
    slot: slot.slot,
    task: opts.task,
    worktreeName: slot.name,
    worktreePath: slot.path,
    profile: opts.profile,
    maxSteps: opts.maxSteps,
  });
  const exitClass = classifyBestOfNExit(result);
  const verifiedCommand =
    typeof result.verifiedCommand === "string" && result.verifiedCommand.trim() !== ""
      ? result.verifiedCommand.trim()
      : undefined;
  return {
    slot: slot.slot,
    worktreeName: slot.name,
    worktreePath: slot.path,
    decision: slot.decision,
    result,
    exitClass,
    verifiedCommand,
  };
}

/** Run the same task on N planned worktree slots; pick first success or best score. */
export async function runBestOfNRace(opts: BestOfNRaceOptions): Promise<BestOfNRaceResult> {
  const task = opts.task.trim();
  if (task === "") {
    return { winner: undefined, attempts: [], n: 0, parallel: opts.parallel === true };
  }
  const n = clampBestOfN(opts.n);
  const stem = opts.nameStem ?? "race";
  let slots: BestOfNWorktreeSlot[] = planBestOfNWorktrees(opts.repoRoot, n, stem, opts.pool ?? {});
  const provisionBySlot = new Map<number, BestOfNWorktreeProvision | undefined>();
  if (opts.worktreeHooks !== undefined) {
    const prepared = await prepareBestOfNWorktreeSlots(opts.repoRoot, slots, opts.worktreeHooks, opts.pool ?? {});
    slots = prepared;
    for (const s of prepared) {
      provisionBySlot.set(s.slot, s.provision);
    }
  }
  const parallel = opts.parallel === true;
  const attempts: BestOfNAttempt[] = [];

  const finish = async (
    winner: BestOfNAttempt | undefined,
    collected: BestOfNAttempt[],
    isParallel: boolean,
  ): Promise<BestOfNRaceResult> => {
    let cleanupNotes: string[] | undefined;
    if (opts.worktreeHooks !== undefined) {
      cleanupNotes = await cleanupBestOfNLoserWorktrees(
        collected,
        winner,
        opts.worktreeHooks,
        provisionBySlot,
      );
    }
    return {
      winner,
      attempts: collected,
      n,
      parallel: isParallel,
      ...(cleanupNotes !== undefined && cleanupNotes.length > 0 ? { cleanupNotes } : {}),
    };
  };

  if (parallel) {
    const pending = slots.map((slot) => runOneAttempt(slot, opts));
    const settled = await Promise.all(pending);
    attempts.push(...settled);
    const winner = pickBestOfNAttempt(attempts);
    return finish(winner, attempts, true);
  }

  for (const slot of slots) {
    const attempt = await runOneAttempt(slot, opts);
    attempts.push(attempt);
    if (attempt.exitClass === "succeeded") {
      return finish(attempt, attempts, false);
    }
  }
  const winner = pickBestOfNAttempt(attempts);
  return finish(winner, attempts, false);
}

export function formatBestOfNRaceOutput(race: BestOfNRaceResult): string {
  if (race.winner === undefined) {
    return race.attempts.length === 0 ? "best-of-n: no attempts" : "best-of-n: every attempt failed";
  }
  const lines = [
    `best-of-n winner slot ${race.winner.slot + 1}/${race.n} (${race.winner.worktreeName}, ${race.winner.exitClass})`,
  ];
  for (const a of race.attempts) {
    const tag = a === race.winner ? "*" : " ";
    const verify = a.verifiedCommand ? ` verified=${JSON.stringify(a.verifiedCommand)}` : "";
    lines.push(
      ` ${tag} slot ${a.slot + 1}: ${a.exitClass} ok=${a.result.ok}${verify} decision=${a.decision.kind}`,
    );
  }
  const body = race.winner.result.output.trim();
  if (body !== "") lines.push("", body);
  if (race.cleanupNotes !== undefined && race.cleanupNotes.length > 0) {
    lines.push("", ...race.cleanupNotes.map((n) => `cleanup: ${n}`));
  }
  return lines.join("\n");
}
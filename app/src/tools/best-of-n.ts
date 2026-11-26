/**
 * `best_of_n` — race the same coding task across N hz worktree slots (opt-in).
 *
 * Uses `ctx.delegate` when present (nested subagent runs). Racing is opt-in
 * (`HZ_BEST_OF_N`); parallel mode via `HZ_BEST_OF_N_PARALLEL=1`.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import {
  bestOfNParallelFromEnv,
  formatBestOfNRaceOutput,
  resolveBestOfNAttemptCount,
  runBestOfNRace,
} from "../core/best-of-n";
import { defaultBestOfNWorktreeHooks } from "../core/best-of-n-worktree";
import { worktreePoolMaxFromEnv } from "../core/worktree-pool";

const DEFAULT_STEPS = 12;
const MAX_STEPS = 20;

function clampSteps(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_STEPS;
  if (n < 1) return 1;
  return Math.min(n, MAX_STEPS);
}

export const bestOfNTool: Tool = {
  name: "best_of_n",
  description:
    "Run the same self-contained coding task N times in hz worktree slots (requires HZ_BEST_OF_N=2..4; max 4) " +
    "and return the first successful subagent result (sequential) or best-scored attempt (HZ_BEST_OF_N_PARALLEL=1). " +
    "Requires delegation; discover via tool_search when you need redundant attempts.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Self-contained task (subagents do not see this conversation).",
      },
      n: {
        type: "number",
        description: "Attempts when HZ_BEST_OF_N is set (overrides env count, max 4).",
      },
      profile: {
        type: "string",
        description: "Optional subagent preset (defaults to code).",
      },
      max_steps: {
        type: "number",
        description: `Model turns per attempt (default ${DEFAULT_STEPS}, max ${MAX_STEPS}).`,
      },
    },
    required: ["task"],
  },
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: {
    keywords: ["best-of-n", "parallel", "race", "retry", "worktree", "redundant", "attempts", "delegate"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (task === "") return { ok: false, output: "", error: "task is required" };
      if (typeof ctx.delegate !== "function") {
        return {
          ok: false,
          output: "Delegation is not available in this context.",
          error: "delegation unavailable",
        };
      }
      const n = resolveBestOfNAttemptCount(args.n);
      if (n === undefined) {
        return {
          ok: false,
          output: "Best-of-N racing is disabled (set HZ_BEST_OF_N=2..4 to opt in).",
          error: "best-of-n: racing disabled",
        };
      }
      const profileRaw = typeof args.profile === "string" ? args.profile.trim() : "";
      const profile = profileRaw !== "" ? profileRaw : "code";
      const maxSteps = clampSteps(args.max_steps);
      const parallel = bestOfNParallelFromEnv();
      const race = await runBestOfNRace({
        repoRoot: ctx.workspace,
        task,
        n,
        parallel,
        nameStem: ctx.sessionId.slice(0, 12),
        profile,
        maxSteps,
        pool: { max: worktreePoolMaxFromEnv() },
        worktreeHooks: defaultBestOfNWorktreeHooks(ctx, ctx.workspace),
        runner: ({ task: t, profile: p, maxSteps: steps, worktreePath }) =>
          ctx.delegate!(t, steps ?? maxSteps, p ?? profile, { workspace: worktreePath }),
      });
      const winner = race.winner;
      if (winner === undefined) {
        return { ok: false, output: formatBestOfNRaceOutput(race), error: "best-of-n: no winning attempt" };
      }
      const output = formatBestOfNRaceOutput(race);
      const childEffectIds = race.attempts.flatMap((a) => a.result.childEffectIds ?? []);
      return {
        ok: winner.result.ok,
        output,
        ...(winner.result.error !== undefined ? { error: winner.result.error } : {}),
        ...(childEffectIds.length > 0 ? { childEffectIds } : {}),
      };
    } catch (e) {
      tunnelPermissionError(e);
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  },
};
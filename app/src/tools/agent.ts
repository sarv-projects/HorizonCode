/**
 * `agent` — delegate a focused task to a subagent in its own context.
 *
 * The tool itself is thin: it validates the request and hands it to the
 * runtime's delegate runner (contracts: DelegateRunner), which runs a nested
 * loop in a child session (core/subagent.ts). The child cannot see this
 * conversation and cannot call this tool — no recursion, no shared context.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import {
  bestOfNCountFromEnv,
  bestOfNParallelFromEnv,
  clampBestOfN,
  formatBestOfNRaceOutput,
  runBestOfNRace,
} from "../core/best-of-n";
import { defaultBestOfNWorktreeHooks } from "../core/best-of-n-worktree";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import { worktreePoolMaxFromEnv } from "../core/worktree-pool";

const DEFAULT_STEPS = 12;
const MAX_STEPS = 20;

/** Model turns for the subagent: default 12, clamped to 1..20. */
function clampSteps(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_STEPS;
  if (n < 1) return 1;
  return Math.min(n, MAX_STEPS);
}

export const agentTool: Tool = {
  name: "agent",
  description:
    "Delegate a focused task to a nested subagent (child session, own transcript — not a background thread). " +
    "The subagent returns one final summary; the parent conversation does not see its tool steps. " +
    "Must be used for self-contained research or multi-step sub-tasks.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The task for the subagent. Write it self-contained: the subagent cannot see this conversation.",
      },
      profile: {
        type: "string",
        description:
          "Optional preset: never, explore, plan, code or review (a user preset may be listed below). `never` is grep/glob-only with read-only isolation. A preset picks a subset of the parent's tools (never agent); the guard still decides every effect. Omit for the generic subagent.",
      },
      max_steps: {
        type: "number",
        description: `Model turns the subagent may use (default ${DEFAULT_STEPS}, max ${MAX_STEPS}).`,
      },
    },
    required: ["task"],
  },

  // Default exclusive: mutating/code subagents must not race. Read-only explore /
  // review / plan / never profiles are treated as shared at batch time via
  // `concurrencyClassOf` + call args (ruling 663) so the parent can fan out.
  concurrencyClass: "exclusive",

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
      if (args.profile !== undefined && typeof args.profile !== "string") {
        return { ok: false, output: "", error: "profile must be a string" };
      }
      const profile = typeof args.profile === "string" && args.profile.trim() !== "" ? args.profile.trim() : undefined;
      const steps = clampSteps(args.max_steps);
      const bonEnv = bestOfNCountFromEnv();
      const useRace =
        bonEnv > 1 && profile !== undefined && profile.toLowerCase() === "code" && typeof ctx.workspace === "string";
      if (useRace) {
        const race = await runBestOfNRace({
          repoRoot: ctx.workspace,
          task,
          n: clampBestOfN(bonEnv),
          parallel: bestOfNParallelFromEnv(),
          nameStem: ctx.sessionId.slice(0, 12),
          profile,
          maxSteps: steps,
          pool: { max: worktreePoolMaxFromEnv() },
          worktreeHooks: defaultBestOfNWorktreeHooks(ctx, ctx.workspace),
          runner: ({ task: t, profile: p, maxSteps: ms, worktreePath }) =>
            ctx.delegate!(t, ms ?? steps, p ?? profile, { workspace: worktreePath }),
        });
        const winner = race.winner;
        if (winner === undefined) {
          return { ok: false, output: formatBestOfNRaceOutput(race), error: "best-of-n: no winning attempt" };
        }
        const output = formatBestOfNRaceOutput(race);
        return {
          ok: winner.result.ok,
          output,
          ...(winner.result.error !== undefined ? { error: winner.result.error } : {}),
          ...(winner.result.childEffectIds !== undefined ? { childEffectIds: winner.result.childEffectIds } : {}),
        };
      }
      return await ctx.delegate(task, steps, profile);
    } catch (e) {
      tunnelPermissionError(e);
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/** Profiles that only observe — safe to run concurrently in one parent batch. */
export const READ_ONLY_AGENT_PROFILES = new Set(["explore", "review", "plan", "never"]);

export function agentCallIsShared(args: Record<string, unknown> | undefined): boolean {
  const profile = typeof args?.profile === "string" ? args.profile.trim().toLowerCase() : "";
  return READ_ONLY_AGENT_PROFILES.has(profile);
}

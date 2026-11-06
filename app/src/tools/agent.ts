/**
 * `agent` — delegate a focused task to a subagent in its own context.
 *
 * The tool itself is thin: it validates the request and hands it to the
 * runtime's delegate runner (contracts: DelegateRunner), which runs a nested
 * loop in a child session (core/subagent.ts). The child cannot see this
 * conversation and cannot call this tool — no recursion, no shared context.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";

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
    "Delegate a focused task to a subagent that works in its own context and returns a final summary. " +
    "Must be used for self-contained research or multi-step sub-tasks.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The task for the subagent. Write it self-contained: the subagent cannot see this conversation.",
      },
      max_steps: {
        type: "number",
        description: `Model turns the subagent may use (default ${DEFAULT_STEPS}, max ${MAX_STEPS}).`,
      },
    },
    required: ["task"],
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
      return await ctx.delegate(task, clampSteps(args.max_steps));
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * `present` — declare final deliverable paths (DeepSeek harness reduced).
 */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { declareDeliverables, declaredDeliverables } from "../core/deliverables";
import { deliverableLineStats, formatDeliverableLineStats } from "../core/deliverable-line-counts";
import { relPath, resolvePath } from "./helpers";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

export const presentTool: Tool = {
  name: "present",
  description:
    "Declare the final file paths that satisfy the task (deliverables). Does not modify files; records intent for the session summary.",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace-relative paths that are the intended final outputs.",
      },
    },
    required: ["files"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = args.files;
    if (!Array.isArray(raw) || raw.length === 0) return fail("files must be a non-empty array of paths");
    const paths: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || item.trim() === "") return fail("each files entry must be a non-empty string");
      const abs = resolvePath(ctx.cwd, item);
      const action: GuardAction = { kind: "fs.read", target: abs };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy for ${item}${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const ok = await ctx.approve({ title: `Present ${relPath(ctx.cwd, abs)}`, detail: abs, kind: "fs.read" }, action);
        if (!ok) return fail("declined by user");
      }
      paths.push(relPath(ctx.workspace, abs));
    }
    const added = declareDeliverables(ctx.sessionId, paths);
    const all = declaredDeliverables(ctx.sessionId);
    const lines = [
      added.length > 0 ? `recorded ${added.length} new deliverable(s)` : "no new paths (already declared)",
      `declared final files (${all.length}):`,
      ...formatDeliverableLineStats(deliverableLineStats(ctx.workspace, all)),
    ];
    return { ok: true, output: lines.join("\n") };
  },
};

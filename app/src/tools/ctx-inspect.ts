/**
 * ctx-inspect.ts — Group D first-class ctx_inspect tool (claude-code
 * CtxInspectTool port). Deferred, pure, produces no effect: it reports the
 * model-visible context budget from ToolContext data only. No guard, no
 * receipt, no filesystem access — safe to call in read-only mode.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";

export const ctxInspectTool: Tool = {
  name: "ctx_inspect",
  description:
    "Inspect the model-visible context budget (workspace, session, token window). Read-only; produces no effect.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Optional field to narrow the report: 'tokens', 'workspace', or 'session'.",
      },
    },
    required: [],
  },
  exposure: "deferred",
  searchInfo: {
    keywords: ["context", "window", "token", "budget", "inspect", "context window"],
  },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = typeof args.topic === "string" ? args.topic.trim().toLowerCase() : "";
    const lines: string[] = [];
    if (topic === "" || topic === "workspace") {
      lines.push(`workspace: ${ctx.workspace}`);
      lines.push(`cwd: ${ctx.cwd}`);
    }
    if (topic === "" || topic === "session") {
      lines.push(`session: ${ctx.sessionId}`);
    }
    if (topic === "" || topic === "tokens") {
      lines.push(`contextWindowTokens: ${ctx.contextWindowTokens ?? "unknown"}`);
    }
    if (lines.length === 0) {
      return { ok: false, output: "", error: `unknown topic: ${topic}` };
    }
    return { ok: true, output: lines.join("\n") };
  },
};

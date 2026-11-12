/**
 * `memory_search` — BM25 recall over workspace memory facts (docs/33 §5.4 partial).
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { memorySearch } from "../core/memory/store";

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

export const memorySearchTool: Tool = {
  name: "memory_search",
  description:
    "Search user-curated workspace memory (FTS index under .hz/memory.db, seeded from MEMORY.md). Read-only recall.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Terms to search for in remembered facts." },
    },
    required: ["query"],
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "recall", "remember", "MEMORY.md", "facts"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return fail("query is required");
    const hits = memorySearch(ctx.workspace, query);
    if (hits.length === 0) return { ok: true, output: "no memory hits" };
    const body = hits.map((h, i) => `${i + 1}. ${h}`).join("\n");
    return { ok: true, output: body };
  },
};

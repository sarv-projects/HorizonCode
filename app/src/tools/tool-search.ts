/**
 * `tool_search` — the Direct meta-tool that discovers Deferred tools
 * (research §1.6, codex ToolExposure reference).
 *
 * Deferred tools are absent from the default spec list. The model finds one by
 * describing what it needs; this tool scores each Deferred candidate's
 * search_info (name + description + keywords) against the query tokens. A
 * matched tool is recorded in the per-session discovery registry (so it becomes
 * visible in toolSpecs(sessionId) and callable for the rest of the session) and
 * its full spec is returned so the model can call it immediately.
 *
 * The matching is DATA-DRIVEN over search_info — there is no per-tool-id logic
 * here; adding a new Deferred tool needs no change to this file.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { deferredSearchCandidates, discoverDeferredTools, getTool } from "./index";

/** Split a string into lowercased alphanumeric tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * A candidate matches if any query token appears (as a substring) in any token
 * of its name/description/keywords, or vice versa. Case-insensitive, data-driven.
 */
function matches(queryTokens: string[], haystack: string[]): boolean {
  for (const q of queryTokens) {
    for (const h of haystack) {
      if (h === q) return true;
      // Substring matching only kicks in for terms of length >= 3, so common
      // short stop-words ("a", "an", "to") in a description never spuriously
      // match an unrelated query token.
      if (q.length >= 3 && h.length >= 3 && (h.includes(q) || q.includes(h))) return true;
    }
  }
  return false;
}

export const toolSearchTool: Tool = {
  name: "tool_search",
  description:
    "Search for additional (deferred) tools by describing what you need. Matching tools are unlocked " +
    "for the rest of the session and their full specs are returned so you can call them immediately.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What you want to do (e.g. 'start a dev server on localhost'). Matched against deferred tool names, descriptions, and keywords.",
      },
    },
    required: ["query"],
  },

  // Always visible: the one entry point for discovering Deferred tools.
  exposure: "direct",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") return { ok: false, output: "", error: "query is required" };

      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) {
        return { ok: true, output: "No searchable terms in the query; no deferred tools matched." };
      }

      const matched: string[] = [];
      for (const candidate of deferredSearchCandidates()) {
        const haystack = [
          ...tokenize(candidate.name),
          ...tokenize(candidate.description),
          ...candidate.keywords.flatMap((k) => tokenize(k)),
        ];
        if (matches(queryTokens, haystack)) matched.push(candidate.name);
      }

      if (matched.length === 0) {
        return { ok: true, output: `No deferred tools matched "${query}".` };
      }

      // Unlock the matched tools for the rest of this session.
      discoverDeferredTools(ctx.sessionId, matched);

      // Return the full specs so the model can call them immediately.
      const specs = matched
        .map((name) => getTool(name))
        .filter((t): t is Tool => t !== undefined)
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      const lines = [
        `Unlocked ${specs.length} tool(s): ${specs.map((s) => s.name).join(", ")}. You can call them now.`,
        ...specs.map((s) => `\n${s.name}: ${s.description}\nparameters: ${JSON.stringify(s.parameters)}`),
      ];
      return { ok: true, output: lines.join("\n") };
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  },
};

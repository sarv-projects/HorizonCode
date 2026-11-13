/**
 * `handoff_*` — session handoff create / resume / search (docs/30 §8 #3).
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import {
  createHandoff,
  normalizeHandoffSections,
  resumeHandoff,
  searchHandoffs,
} from "../core/memory/handoff";

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

function formatCreate(r: Awaited<ReturnType<typeof createHandoff>>): string {
  const lines = [`id: ${r.id}`, `branch: ${r.branch}`, `continues_from: ${r.continues_from ?? "(none)"}`];
  if (r.warnings.length > 0) lines.push(`warnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
  return lines.join("\n");
}

function formatResume(r: Awaited<ReturnType<typeof resumeHandoff>>): string {
  const lines: string[] = [`branch: ${r.branch}`, `latest: ${r.latest_handoff_id ?? "(none)"}`, `chain: ${r.chain.join(" → ") || "(empty)"}`];
  if (r.message) lines.push(`note: ${r.message}`);
  if (r.open_blockers.length > 0) {
    lines.push(`blockers:\n${r.open_blockers.map((b) => `- ${b}`).join("\n")}`);
  }
  if (r.top_sections.length > 0) {
    lines.push(
      "sections:",
      ...r.top_sections.map(
        (s, i) => `${i + 1}. [${s.handoff_id}/${s.section_name}] (score ${s.score.toFixed(3)})\n${s.section_text}`,
      ),
    );
  }
  return lines.join("\n");
}

export const handoffCreateTool: Tool = {
  name: "handoff_create",
  description:
    "Store a session handoff under the workspace (.hz/state/handoffs.db). Summary required; optional tried/next/blockers/decisions/files/context. No todos section — use todo tool instead.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Short session summary (required)." },
      tried: {
        type: "array",
        items: { type: "string" },
        description: "What was attempted this session.",
      },
      next: {
        type: "array",
        items: { type: "string" },
        description: "Suggested next steps (not durable todos).",
      },
      blockers: { type: "array", items: { type: "string" } },
      decisions: { type: "array", items: { type: "string" } },
      files: { type: "string", description: "Relevant file paths or notes." },
      context: { type: "string", description: "Extra narrative context." },
      continues_from: { type: "string", description: "Prior handoff id to chain from (optional)." },
      branch: { type: "string", description: "Override branch scope (optional)." },
    },
    required: ["summary"],
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["handoff", "session", "resume", "context", "continues"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const normalized = normalizeHandoffSections(args);
    if ("error" in normalized) return fail(normalized.error);
    const branchOverride = typeof args.branch === "string" ? args.branch : undefined;
    const continuesArg = args.continues_from;
    const continues_from =
      continuesArg === null ? null : typeof continuesArg === "string" ? continuesArg.trim() || null : undefined;
    const result = createHandoff(ctx.workspace, normalized, {
      branch: branchOverride,
      continues_from,
      auto_continue: continues_from === undefined,
    });
    return { ok: true, output: formatCreate(result) };
  },
};

export const handoffResumeTool: Tool = {
  name: "handoff_resume",
  description:
    "Resume from the latest handoff on the current branch (or detached workspace scope). Walks continues_from chain (max 5). Optional BM25 query ranks sections.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Terms to rank matching sections." },
      handoff_id: { type: "string", description: "Start from a specific handoff id." },
      branch: { type: "string" },
      max_sections: { type: "number" },
    },
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["handoff", "resume", "session", "continues", "chain"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query : undefined;
    const handoff_id = typeof args.handoff_id === "string" ? args.handoff_id : undefined;
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const max_sections = typeof args.max_sections === "number" ? args.max_sections : undefined;
    const result = resumeHandoff(ctx.workspace, { query, handoff_id, branch, max_sections });
    if (result.latest_handoff_id === null) {
      return { ok: true, output: `no handoff on branch ${result.branch}${result.message ? ` (${result.message})` : ""}` };
    }
    return { ok: true, output: formatResume(result) };
  },
};

export const handoffSearchTool: Tool = {
  name: "handoff_search",
  description: "BM25 search across handoff section text for the current branch scope.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms." },
      branch: { type: "string" },
      limit: { type: "number" },
      section_filter: {
        type: "array",
        items: { type: "string" },
        description: "Limit to section names (e.g. tried, blockers).",
      },
    },
    required: ["query"],
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["handoff", "search", "session", "recall"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return fail("query is required");
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const section_filter = Array.isArray(args.section_filter)
      ? args.section_filter.filter((x): x is string => typeof x === "string")
      : undefined;
    const { matches } = searchHandoffs(ctx.workspace, query, { branch, limit, section_filter });
    if (matches.length === 0) return { ok: true, output: "no handoff matches" };
    const body = matches
      .map(
        (m, i) =>
          `${i + 1}. [${m.handoff_id}/${m.section_name}] score=${m.score.toFixed(3)}\n${m.section_text.slice(0, 500)}`,
      )
      .join("\n\n");
    return { ok: true, output: body };
  },
};

/**
 * `handoff_*` — session handoff create / resume / search (docs/30 §8 #3).
 */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { hookAuditBlockForHandoff } from "../core/hook-handoff-capture";
import {
  createHandoff,
  handoffDbPath,
  normalizeHandoffSections,
  resumeHandoff,
  searchHandoffs,
} from "../core/memory/handoff";
import {
  durableBranchTrackPath,
  durableTodosEnabled,
  mergeDurableBranchOpenTodos,
} from "../core/durable-todos";
import { importSnapshottedTodosGuarded, openTodos } from "./todo";

async function admitHandoffDbWrite(ctx: ToolContext, title: string): Promise<string | undefined> {
  const target = handoffDbPath(ctx.workspace);
  const action: GuardAction = { kind: "fs.write", target };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const approved = await ctx.approve({ title, detail: target, kind: "fs.write" }, action);
    if (!approved) return "declined by user";
  }
  return undefined;
}

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

function formatCreate(
  r: Awaited<ReturnType<typeof createHandoff>>,
  todosSnapshotted: number,
  hookAuditLines: number,
): string {
  const lines = [`id: ${r.id}`, `branch: ${r.branch}`, `continues_from: ${r.continues_from ?? "(none)"}`];
  if (r.session_id) lines.push(`session_id: ${r.session_id}`);
  if (todosSnapshotted > 0) lines.push(`snapshotted_open_todos: ${todosSnapshotted}`);
  if (hookAuditLines > 0) lines.push(`hook_audit_lines: ${hookAuditLines} (in context section)`);
  if (r.warnings.length > 0) lines.push(`warnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
  return lines.join("\n");
}

function formatResume(
  r: Awaited<ReturnType<typeof resumeHandoff>>,
  live: Array<{ id: string; text: string }>,
  rehydrate?: { added: number; skipped: number },
  durableMerge?: { merged: number; skipped: number; fromBranch: string },
): string {
  const lines: string[] = [`branch: ${r.branch}`, `latest: ${r.latest_handoff_id ?? "(none)"}`, `chain: ${r.chain.join(" → ") || "(empty)"}`];
  if (r.source_session_id) lines.push(`source_session_id: ${r.source_session_id}`);
  if (r.message) lines.push(`note: ${r.message}`);
  if (durableMerge !== undefined && durableMerge.merged + durableMerge.skipped > 0) {
    lines.push(
      `merged_durable_todos: ${durableMerge.merged} from branch ${durableMerge.fromBranch} (${durableMerge.skipped} skipped duplicate text)`,
    );
  }
  if (rehydrate !== undefined && rehydrate.added > 0) {
    lines.push(`rehydrated_todos: ${rehydrate.added} imported (${rehydrate.skipped} skipped)`);
  }
  if (live.length > 0) {
    lines.push("open_todos (live session list):\n" + live.map((t) => `- [${t.id}] ${t.text}`).join("\n"));
  }
  if (r.open_blockers.length > 0) {
    lines.push(`blockers:\n${r.open_blockers.map((b) => `- ${b}`).join("\n")}`);
  }
  if (r.snapshotted_todos.length > 0) {
    lines.push(
      "snapshotted_open_todos (at handoff create; history only unless rehydrate_todos):\n" +
        r.snapshotted_todos.map((t) => `- ${t}`).join("\n"),
    );
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
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: { keywords: ["handoff", "session", "resume", "context", "continues"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const normalized = normalizeHandoffSections(args);
    if ("error" in normalized) return fail(normalized.error);
    const denied = await admitHandoffDbWrite(ctx, "Create handoff");
    if (denied !== undefined) return fail(denied);
    const branchOverride = typeof args.branch === "string" ? args.branch : undefined;
    const continuesArg = args.continues_from;
    const continues_from =
      continuesArg === null ? null : typeof continuesArg === "string" ? continuesArg.trim() || null : undefined;
    const todos_snapshot = openTodos(ctx.sessionId).map((t) => `[${t.id}] ${t.text}`);
    const hookBlock = hookAuditBlockForHandoff(ctx.sessionId, ctx.workspace);
    const baseContext = normalized.context ?? "";
    const context =
      hookBlock === ""
        ? baseContext
        : baseContext.trim() === ""
          ? hookBlock
          : `${baseContext.trim()}\n\n${hookBlock}`;
    const result = createHandoff(ctx.workspace, { ...normalized, context }, {
      branch: branchOverride,
      continues_from,
      auto_continue: continues_from === undefined,
      todos_snapshot,
      session_id: ctx.sessionId,
    });
    const hookAuditLines = hookBlock === "" ? 0 : hookBlock.split("\n").filter((l) => l.startsWith("- ")).length;
    return { ok: true, output: formatCreate(result, todos_snapshot.length, hookAuditLines) };
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
      diversify: {
        type: "boolean",
        description: "When query is set: lexical MMR over BM25 hits (default true).",
      },
      rehydrate_todos: {
        type: "boolean",
        description:
          "When true, import snapshotted open todos from the resumed handoff into this session's live todo list (skips duplicate text).",
      },
      merge_durable_branch: {
        type: "string",
        description:
          "When HZ_TODO_DURABLE=1: copy open todos from another git/handoff branch into this branch's durable store (dedupe by text).",
      },
    },
  },
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: { keywords: ["handoff", "resume", "session", "continues", "chain"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query : undefined;
    const handoff_id = typeof args.handoff_id === "string" ? args.handoff_id : undefined;
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const max_sections = typeof args.max_sections === "number" ? args.max_sections : undefined;
    const diversify = args.diversify === false ? false : undefined;
    const rehydrate_todos = args.rehydrate_todos === true;
    const merge_durable_branch =
      typeof args.merge_durable_branch === "string" ? args.merge_durable_branch.trim() : "";
    let durableMerge: { merged: number; skipped: number; fromBranch: string } | undefined;
    if (merge_durable_branch !== "" && durableTodosEnabled()) {
      const denied = await admitHandoffDbWrite(ctx, "Merge durable todos");
      if (denied !== undefined) return fail(denied);
      const trackTarget = durableBranchTrackPath(ctx.workspace);
      const trackAction: GuardAction = { kind: "fs.write", target: trackTarget };
      const trackDecision = await ctx.guard(trackAction);
      if (trackDecision.decision === "deny") {
        return fail(`denied by policy${trackDecision.reason ? `: ${trackDecision.reason}` : ""}`);
      }
      if (trackDecision.decision === "ask") {
        const approved = await ctx.approve(
          { title: "Persist durable todo branch track", detail: trackTarget, kind: "fs.write" },
          trackAction,
        );
        if (!approved) return fail("declined by user");
      }
      const stats = mergeDurableBranchOpenTodos(ctx.workspace, merge_durable_branch);
      durableMerge = { ...stats, fromBranch: merge_durable_branch };
    }
    const result = resumeHandoff(ctx.workspace, {
      query,
      handoff_id,
      branch,
      max_sections,
      ...(diversify === false ? { diversify: false } : {}),
    });
    if (result.latest_handoff_id === null) {
      const live = openTodos(ctx.sessionId);
      const prefix =
        live.length > 0
          ? `open_todos (live):\n${live.map((t) => `- [${t.id}] ${t.text}`).join("\n")}\n\n`
          : "";
      return {
        ok: true,
        output: `${prefix}no handoff on branch ${result.branch}${result.message ? ` (${result.message})` : ""}`,
      };
    }
    let rehydrate: { added: number; skipped: number } | undefined;
    if (rehydrate_todos && result.snapshotted_todos.length > 0) {
      const imported = await importSnapshottedTodosGuarded(ctx, result.snapshotted_todos);
      if ("error" in imported) return fail(imported.error);
      rehydrate = imported;
    }
    const live = openTodos(ctx.sessionId);
    return { ok: true, output: formatResume(result, live, rehydrate, durableMerge) };
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
      diversify: {
        type: "boolean",
        description: "Lexical MMR over BM25 hits (default true).",
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
    const diversify = args.diversify === false ? false : true;
    const { matches } = searchHandoffs(ctx.workspace, query, { branch, limit, section_filter, diversify });
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

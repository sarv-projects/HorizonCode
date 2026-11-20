/** `todo` — session-scoped todo checklist. */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import {
  branchKeyForWorkspace,
  durableTodosEnabled,
  loadBranchTodos,
  saveBranchTodos,
  type DurableTodoRow,
} from "../core/durable-todos";
import { handoffDbPath } from "../core/memory/handoff";

interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** Closed without completing (Engram `drop`); omitted from `openTodos`. */
  dropped?: boolean;
  dropReason?: string;
}

/** Session-scoped store; a fresh process starts with an empty plan. */
const STORE = new Map<string, Todo[]>();

/** Per-session count of list mutations (add, done); lets a run tell if it touched the list. */
const VERSIONS = new Map<string, number>();

function bump(sessionId: string): void {
  VERSIONS.set(sessionId, (VERSIONS.get(sessionId) ?? 0) + 1);
}

/** The session's todo mutation counter; 0 when the list was never touched. */
export function todoVersion(sessionId: string): number {
  return VERSIONS.get(sessionId) ?? 0;
}

export type TodoEventStatus = "pending" | "completed" | "cancelled";

/** Kernel payload for `hz.todo.updated` (reduced schema; ruling 386). */
export function todoUpdatedEventPayload(
  sessionId: string,
  change: "added" | "updated",
): { sessionId: string; revision: number; change: typeof change; todos: Array<{ id: string; text: string; status: TodoEventStatus }> } {
  const list = STORE.get(sessionId) ?? [];
  const todos = list.map((t) => ({
    id: t.id,
    text: t.text,
    status: (t.dropped ? "cancelled" : t.done ? "completed" : "pending") as TodoEventStatus,
  }));
  return { sessionId, revision: todoVersion(sessionId), change, todos };
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function items(sessionId: string): Todo[] {
  let list = STORE.get(sessionId);
  if (!list) {
    list = [];
    STORE.set(sessionId, list);
  }
  return list;
}

/**
 * The session's items not yet done, in order. Read-only and allocation-light:
 * the loop's end-of-turn todo re-check (T-3) uses it and never creates a list.
 */
export function openTodos(sessionId: string): Array<{ id: string; text: string }> {
  return (STORE.get(sessionId) ?? [])
    .filter((t) => !t.done && t.dropped !== true)
    .map((t) => ({ id: t.id, text: t.text }));
}

const SNAPSHOT_TODO_RE = /^\[([^\]]+)\]\s*(.+)$/;

/** Parse `[t1] fix lint` lines from handoff create snapshots. */
export function parseSnapshottedTodoLine(line: string): { id: string; text: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const m = SNAPSHOT_TODO_RE.exec(trimmed);
  if (!m) return null;
  const id = m[1]!.trim();
  const text = m[2]!.trim();
  if (id === "" || text === "") return null;
  return { id, text };
}

function checklist(list: Todo[]): string {
  if (list.length === 0) return "No todos.";
  return list
    .map((t) => {
      const mark = t.dropped ? "~" : t.done ? "x" : " ";
      const suffix =
        t.dropped && typeof t.dropReason === "string" && t.dropReason !== ""
          ? ` (dropped: ${t.dropReason})`
          : "";
      return `[${mark}] ${t.id} ${t.text}${suffix}`;
    })
    .join("\n");
}

function syncDurable(workspace: string, list: Todo[]): void {
  if (!durableTodosEnabled()) return;
  const branch = branchKeyForWorkspace(workspace);
  const rows: DurableTodoRow[] = list.map((t) => ({
    id: t.id,
    text: t.text,
    done: t.done,
    ...(t.dropped ? { dropped: true, dropReason: t.dropReason } : {}),
  }));
  saveBranchTodos(workspace, branch, rows);
}

/**
 * Opt-in durable persistence writes `handoffs.db`. Admit that path before
 * mutating disk so session-state todo calls cannot bypass Guard.
 */
async function admitFsWrite(
  ctx: ToolContext,
  target: string,
  title: string,
): Promise<string | undefined> {
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

async function syncDurableGuarded(ctx: ToolContext, list: Todo[]): Promise<string | undefined> {
  if (!durableTodosEnabled()) return undefined;
  const dbDenied = await admitFsWrite(ctx, handoffDbPath(ctx.workspace), "Persist durable todos");
  if (dbDenied !== undefined) return dbDenied;
  // Ruling 599: branch-track JSON is a second durable path beside handoffs.db.
  const { durableBranchTrackPath } = await import("../core/durable-todos");
  const trackDenied = await admitFsWrite(
    ctx,
    durableBranchTrackPath(ctx.workspace),
    "Persist durable todo branch track",
  );
  if (trackDenied !== undefined) return trackDenied;
  syncDurable(ctx.workspace, list);
  return undefined;
}

const MAX_MERGE_OPS = 32;

type MergeOp = { op: "add" | "done" | "drop"; text?: string; id?: string; reason?: string };

function findOpenDuplicate(list: Todo[], text: string): Todo | undefined {
  return list.find((t) => !t.done && t.dropped !== true && t.text === text);
}

function applyMergeOp(list: Todo[], op: MergeOp): string | undefined {
  if (op.op === "add") {
    const text = typeof op.text === "string" ? op.text.trim() : "";
    if (text === "") return "merge add: text is required";
    const dup = findOpenDuplicate(list, text);
    if (dup) return `duplicate open todo: ${dup.id} (same text)`;
    list.push({ id: nextId(list), text, done: false });
    return undefined;
  }
  if (op.op === "done") {
    const id = typeof op.id === "string" ? op.id.trim() : typeof op.text === "string" ? op.text.trim() : "";
    if (id === "") return "merge done: id is required";
    const item = list.find((t) => t.id === id);
    if (!item) return `todo not found: ${id}`;
    if (item.dropped) return `todo already dropped: ${id}`;
    item.done = true;
    return undefined;
  }
  if (op.op === "drop") {
    const id = typeof op.id === "string" ? op.id.trim() : typeof op.text === "string" ? op.text.trim() : "";
    const reason = typeof op.reason === "string" ? op.reason.trim() : "";
    if (id === "") return "merge drop: id is required";
    if (reason === "") return "merge drop: reason is required";
    const item = list.find((t) => t.id === id);
    if (!item) return `todo not found: ${id}`;
    if (item.done) return `todo already done: ${id}`;
    if (item.dropped) return `todo already dropped: ${id}`;
    item.dropped = true;
    item.dropReason = reason;
    return undefined;
  }
  return `merge: unknown op ${String(op.op)}`;
}

function parseMergeOps(raw: unknown): { ops: MergeOp[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "ops must be an array for merge" };
  if (raw.length === 0) return { error: "ops must not be empty for merge" };
  if (raw.length > MAX_MERGE_OPS) return { error: `ops exceeds max ${MAX_MERGE_OPS}` };
  const ops: MergeOp[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
    if (row === null || typeof row !== "object") return { error: `ops[${i}] must be an object` };
    const op = (row as Record<string, unknown>).op;
    if (op !== "add" && op !== "done" && op !== "drop") return { error: `ops[${i}].op must be add, done or drop` };
    ops.push({
      op,
      ...(typeof (row as Record<string, unknown>).text === "string" ? { text: (row as Record<string, unknown>).text as string } : {}),
      ...(typeof (row as Record<string, unknown>).id === "string" ? { id: (row as Record<string, unknown>).id as string } : {}),
      ...(typeof (row as Record<string, unknown>).reason === "string"
        ? { reason: (row as Record<string, unknown>).reason as string }
        : {}),
    });
  }
  return { ops };
}

function nextId(list: Todo[]): string {
  let max = 0;
  for (const t of list) {
    const n = Number(t.id.slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}

/**
 * Import handoff snapshotted todo lines into the session live list.
 * Skips items whose text already appears on an open todo (case-sensitive).
 */
export function importSnapshottedTodos(
  sessionId: string,
  lines: string[],
  workspace?: string,
): { added: number; skipped: number } {
  const list = items(sessionId);
  const openTexts = new Set(list.filter((t) => !t.done).map((t) => t.text));
  let added = 0;
  let skipped = 0;
  for (const raw of lines) {
    const parsed = parseSnapshottedTodoLine(raw);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    if (openTexts.has(parsed.text)) {
      skipped += 1;
      continue;
    }
    const idTaken = list.some((t) => t.id === parsed.id);
    list.push({
      id: idTaken ? nextId(list) : parsed.id,
      text: parsed.text,
      done: false,
    });
    openTexts.add(parsed.text);
    added += 1;
    bump(sessionId);
  }
  // Durable disk sync is intentionally not done here — callers that need
  // `HZ_TODO_DURABLE=1` persistence must use `importSnapshottedTodosGuarded`
  // so `handoffs.db` is Guard-admitted first. `workspace` is retained for API
  // compatibility with existing call sites.
  void workspace;
  return { added, skipped };
}

/** Rehydrate session todos, then persist under Guard when durable is on. */
export async function importSnapshottedTodosGuarded(
  ctx: ToolContext,
  lines: string[],
): Promise<{ added: number; skipped: number } | { error: string }> {
  const stats = importSnapshottedTodos(ctx.sessionId, lines, undefined);
  if (stats.added === 0 || !durableTodosEnabled()) return stats;
  const list = items(ctx.sessionId);
  const err = await syncDurableGuarded(ctx, list);
  if (err !== undefined) return { error: err };
  return stats;
}

/** Hydrate an empty session list from branch-scoped durable storage (opt-in). */
export function hydrateTodosFromDurable(workspace: string, sessionId: string): number {
  if (!durableTodosEnabled()) return 0;
  const list = STORE.get(sessionId) ?? [];
  if (list.length > 0) return 0;
  const rows = loadBranchTodos(workspace);
  if (rows.length === 0) return 0;
  const hydrated: Todo[] = rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done,
    ...(r.dropped ? { dropped: true, dropReason: r.dropReason } : {}),
  }));
  STORE.set(sessionId, hydrated);
  if (hydrated.some((t) => !t.done)) bump(sessionId);
  return hydrated.filter((t) => !t.done).length;
}

export const todoTool: Tool = {
  name: "todo",
  description:
    "Maintain the session todo checklist: list, add, mark done, drop (with reason), or merge several ops in one call. Durable across sessions when HZ_TODO_DURABLE=1.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "done", "drop", "merge"],
        description: "Checklist operation.",
      },
      text: { type: "string", description: "Item text for 'add', or the item id (e.g. 't1') for 'done' or 'drop'." },
      reason: { type: "string", description: "Required for 'drop' — why this todo no longer applies." },
      ops: {
        type: "array",
        description: "For 'merge': ordered {op,text?|id?,reason?} entries (add/done/drop), max 32.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "done", "drop"] },
            text: { type: "string" },
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["op"],
        },
      },
    },
    required: ["action"],
  },

  // NF-072: a mutating tool (session state) — an exclusive call is its own barrier.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const action = args.action;
      if (action !== "list" && action !== "add" && action !== "done" && action !== "drop" && action !== "merge") {
        return fail(`unknown action: ${String(action)} (expected list, add, done, drop or merge)`);
      }
      const list = items(ctx.sessionId);

      if (action === "add") {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (text === "") return fail("text is required for add");
        const dup = findOpenDuplicate(list, text);
        if (dup) return fail(`duplicate open todo: ${dup.id} (same text)`);
        list.push({ id: nextId(list), text, done: false });
        bump(ctx.sessionId);
        const durableErr = await syncDurableGuarded(ctx, list);
        if (durableErr !== undefined) return fail(durableErr);
        return { ok: true, output: checklist(list) };
      }

      if (action === "merge") {
        const parsed = parseMergeOps(args.ops);
        if ("error" in parsed) return fail(parsed.error);
        for (let i = 0; i < parsed.ops.length; i += 1) {
          const err = applyMergeOp(list, parsed.ops[i]!);
          if (err !== undefined) return fail(`ops[${i}]: ${err}`);
        }
        bump(ctx.sessionId);
        const durableErr = await syncDurableGuarded(ctx, list);
        if (durableErr !== undefined) return fail(durableErr);
        return { ok: true, output: checklist(list) };
      }

      if (action === "done") {
        const id = typeof args.text === "string" ? args.text.trim() : "";
        if (id === "") return fail("text (item id) is required for done");
        const item = list.find((t) => t.id === id);
        if (!item) return fail(`todo not found: ${id}`);
        if (item.dropped) return fail(`todo already dropped: ${id}`);
        item.done = true;
        bump(ctx.sessionId);
        const durableErr = await syncDurableGuarded(ctx, list);
        if (durableErr !== undefined) return fail(durableErr);
        return { ok: true, output: checklist(list) };
      }

      if (action === "drop") {
        const id = typeof args.text === "string" ? args.text.trim() : "";
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (id === "") return fail("text (item id) is required for drop");
        if (reason === "") return fail("reason is required for drop");
        const item = list.find((t) => t.id === id);
        if (!item) return fail(`todo not found: ${id}`);
        if (item.done) return fail(`todo already done: ${id}`);
        if (item.dropped) return fail(`todo already dropped: ${id}`);
        item.dropped = true;
        item.dropReason = reason;
        bump(ctx.sessionId);
        const durableErr = await syncDurableGuarded(ctx, list);
        if (durableErr !== undefined) return fail(durableErr);
        return { ok: true, output: checklist(list) };
      }

      return { ok: true, output: checklist(list) };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

/** Engram / forge-style name for the same checklist tool (ruling 395). */
export const todoWriteTool: Tool = {
  ...todoTool,
  name: "todo_write",
  description:
    "Alias for `todo`: session checklist list/add/done/drop/merge (Engram `todo_write` naming). Durable when HZ_TODO_DURABLE=1.",
};

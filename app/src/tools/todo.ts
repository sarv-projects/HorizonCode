/** `todo` — session-scoped todo checklist. */

import type { Tool, ToolContext, ToolResult } from "../contracts";

interface Todo {
  id: string;
  text: string;
  done: boolean;
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
  return (STORE.get(sessionId) ?? []).filter((t) => !t.done).map((t) => ({ id: t.id, text: t.text }));
}

function checklist(list: Todo[]): string {
  if (list.length === 0) return "No todos.";
  return list.map((t) => `[${t.done ? "x" : " "}] ${t.id} ${t.text}`).join("\n");
}

function nextId(list: Todo[]): string {
  let max = 0;
  for (const t of list) {
    const n = Number(t.id.slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}

export const todoTool: Tool = {
  name: "todo",
  description: "Maintain the session todo checklist: list, add, or complete items.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "done"], description: "Checklist operation." },
      text: { type: "string", description: "Item text for 'add', or the item id (e.g. 't1') for 'done'." },
    },
    required: ["action"],
  },

  // NF-072: a mutating tool (session state) — an exclusive call is its own barrier.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const action = args.action;
      if (action !== "list" && action !== "add" && action !== "done") {
        return fail(`unknown action: ${String(action)} (expected list, add or done)`);
      }
      const list = items(ctx.sessionId);

      if (action === "add") {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (text === "") return fail("text is required for add");
        list.push({ id: nextId(list), text, done: false });
        bump(ctx.sessionId);
        return { ok: true, output: checklist(list) };
      }

      if (action === "done") {
        const id = typeof args.text === "string" ? args.text.trim() : "";
        if (id === "") return fail("text (item id) is required for done");
        const item = list.find((t) => t.id === id);
        if (!item) return fail(`todo not found: ${id}`);
        item.done = true;
        bump(ctx.sessionId);
        return { ok: true, output: checklist(list) };
      }

      return { ok: true, output: checklist(list) };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

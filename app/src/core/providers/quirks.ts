/**
 * quirks.ts — forgecode T-8 reduced form (docs/33 §5.10).
 *
 * Request-body transforms are code; host/model → quirk selection is data
 * (`provider-quirks.compat.json`, H-6 partial — not a full KDL cascade).
 */

import compatTable from "./provider-quirks.compat.json" with { type: "json" };

export interface QuirkContext {
  provider: string;
  model: string;
  baseUrl: string;
}

export type Quirk = {
  id: string;
  applies: (ctx: QuirkContext) => boolean;
  transform: (body: Record<string, unknown>) => void;
};

export interface CompatEntry {
  quirk: string;
  hostNeedles?: string[];
  modelNeedles?: string[];
  modelRegex?: string;
}

/** Host substring match against `provider` + `baseUrl` (case-insensitive). */
export function hostIncludes(ctx: QuirkContext, needle: string): boolean {
  const h = `${ctx.provider} ${ctx.baseUrl}`.toLowerCase();
  return h.includes(needle.toLowerCase());
}

function entryApplies(ctx: QuirkContext, entry: CompatEntry): boolean {
  if (entry.hostNeedles?.some((n) => hostIncludes(ctx, n))) return true;
  const model = ctx.model.toLowerCase();
  if (entry.modelNeedles?.some((n) => model.includes(n.toLowerCase()))) return true;
  if (entry.modelRegex) {
    try {
      if (new RegExp(entry.modelRegex, "i").test(ctx.model)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

type TransformFn = (body: Record<string, unknown>) => void;

const TRANSFORMS: Record<string, TransformFn> = {
  ensure_system_first: (body) => {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || msgs.length < 2) return;
    const first = msgs[0] as Record<string, unknown>;
    if (first.role !== "system") return;
    const rest = msgs.slice(1);
    const sysIdx = rest.findIndex((m) => (m as Record<string, unknown>).role === "system");
    if (sysIdx <= 0) return;
    const [sys] = rest.splice(sysIdx, 1);
    body.messages = [first, sys, ...rest];
  },
  trim_parallel_tool_calls: (body) => {
    delete body.parallel_tool_calls;
  },
  drop_reasoning_effort: (body) => {
    delete body.reasoning_effort;
  },
  trim_tool_call_ids: (body) => {
    const msgs = body.messages;
    if (!Array.isArray(msgs)) return;
    for (const raw of msgs) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const msg = raw as Record<string, unknown>;
      const calls = msg.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
        const tc = call as { id?: string };
        if (typeof tc.id === "string" && tc.id.length > 40) tc.id = tc.id.slice(0, 40);
      }
    }
  },
  o_series_max_completion_tokens: (body) => {
    if (!Object.prototype.hasOwnProperty.call(body, "max_tokens")) return;
    if (Object.prototype.hasOwnProperty.call(body, "max_completion_tokens")) {
      delete body.max_tokens;
      return;
    }
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  },
  drop_response_format: (body) => {
    delete body.response_format;
  },
  drop_parallel_tools_mistral: (body) => {
    delete body.parallel_tool_calls;
  },
  strip_assistant_name: (body) => {
    const msgs = body.messages;
    if (!Array.isArray(msgs)) return;
    for (const raw of msgs) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const msg = raw as Record<string, unknown>;
      if (msg.role === "assistant") delete msg.name;
    }
  },
  drop_tool_choice: (body) => {
    delete body.tool_choice;
  },
  force_user_message: (body) => {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    const last = msgs[msgs.length - 1] as Record<string, unknown>;
    if (last.role === "tool") {
      msgs.push({ role: "user", content: "Continue." });
    }
  },
};

function compileQuirks(entries: CompatEntry[]): Quirk[] {
  const seen = new Set<string>();
  const quirks: Quirk[] = [];
  for (const entry of entries) {
    if (seen.has(entry.quirk)) continue;
    const transform = TRANSFORMS[entry.quirk];
    if (!transform) continue;
    seen.add(entry.quirk);
    quirks.push({
      id: entry.quirk,
      applies: (ctx) => entries.some((e) => e.quirk === entry.quirk && entryApplies(ctx, e)),
      transform,
    });
  }
  return quirks;
}

const COMPAT_ENTRIES = (compatTable as { entries: CompatEntry[] }).entries;

export const QUIRKS: Quirk[] = compileQuirks(COMPAT_ENTRIES);

export function applyQuirks(ctx: QuirkContext, body: Record<string, unknown>): string[] {
  const applied: string[] = [];
  for (const q of QUIRKS) {
    if (!q.applies(ctx)) continue;
    q.transform(body);
    applied.push(q.id);
  }
  return applied;
}

/** Quirk ids that would apply to the next request (for `message.start` logging). */
export function previewQuirks(ctx: QuirkContext): string[] {
  return QUIRKS.filter((q) => q.applies(ctx)).map((q) => q.id);
}

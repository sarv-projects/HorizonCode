/**
 * quirks.ts — forgecode T-8 reduced form (docs/33 §5.10).
 *
 * Small pure transforms on the OpenAI-chat request body, selected by host/model.
 */

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

/** Host/model id substring match (case-insensitive). */
function hostIncludes(ctx: QuirkContext, needle: string): boolean {
  const h = `${ctx.provider} ${ctx.baseUrl}`.toLowerCase();
  return h.includes(needle.toLowerCase());
}

export const QUIRKS: Quirk[] = [
  {
    id: "ensure_system_first",
    applies: (ctx) => hostIncludes(ctx, "cerebras") || hostIncludes(ctx, "nvidia"),
    transform: (body) => {
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
  },
  {
    id: "trim_parallel_tool_calls",
    applies: (ctx) => hostIncludes(ctx, "cerebras"),
    transform: (body) => {
      delete body.parallel_tool_calls;
    },
  },
  {
    id: "drop_reasoning_effort",
    applies: (ctx) => hostIncludes(ctx, "cerebras"),
    transform: (body) => {
      delete body.reasoning_effort;
    },
  },
  {
    id: "trim_tool_call_ids",
    applies: (ctx) => hostIncludes(ctx, "groq") || hostIncludes(ctx, "nvidia"),
    transform: (body) => {
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
  },
  {
    // OpenAI o-series rejects `max_tokens` in favour of `max_completion_tokens`.
    id: "o_series_max_completion_tokens",
    applies: (ctx) => {
      const m = ctx.model.toLowerCase();
      return /(?:^|[/_.-])o[1-9](?:$|[/_.-])/.test(m) || m.includes("o1-") || m.includes("o3-") || m.includes("o4-");
    },
    transform: (body) => {
      if (!Object.prototype.hasOwnProperty.call(body, "max_tokens")) return;
      if (Object.prototype.hasOwnProperty.call(body, "max_completion_tokens")) {
        delete body.max_tokens;
        return;
      }
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    },
  },
  {
    // Some OpenAI-compatible hosts reject assistant `name` on tool-bearing turns.
    id: "strip_assistant_name",
    applies: (ctx) => hostIncludes(ctx, "groq") || hostIncludes(ctx, "together"),
    transform: (body) => {
      const msgs = body.messages;
      if (!Array.isArray(msgs)) return;
      for (const raw of msgs) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const msg = raw as Record<string, unknown>;
        if (msg.role === "assistant") delete msg.name;
      }
    },
  },
];

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

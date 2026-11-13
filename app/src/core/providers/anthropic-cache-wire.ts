/**
 * Wire `cache-breakpoints.ts` onto Anthropic request bodies (docs/30 B-4).
 *
 * Off unless `HZ_ANTHROPIC_CACHE_BREAKPOINTS=1` (default prefix planner on when enabled). Composes with
 * `HZ_ANTHROPIC_CACHE_SYSTEM=1` (system may already be a cached block array).
 * When breakpoints are on, tool_result markers use the largest stable prefix (ruling **277** / **276**).
 * Residual: live cache-hit measure (keep-alive stub: ruling 246).
 */

import { cacheableBlocksCutIndex } from "./cacheable-messages-prefix";
import {
  applyCacheBreakpoints,
  planCacheBreakpoints,
  type CacheableBlock,
} from "./cache-breakpoints";

export interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

type WireSlot =
  | { target: "system"; blockIndex: number }
  | { target: "message"; msgIndex: number; blockIndex: number };

export function anthropicCacheBreakpointsEnabled(): boolean {
  return process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS === "1";
}

function cacheableKind(
  block: Record<string, unknown>,
  role: "user" | "assistant",
): CacheableBlock["kind"] {
  if (block.type === "tool_result") return "tool_result";
  if (block.type === "text" && role === "user") return "stable";
  return "other";
}

function blockText(block: Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "tool_result" && typeof block.content === "string") return block.content;
  return "";
}

/**
 * Plan and stamp up to `BREAKPOINT_CAP` ephemeral markers on system + message content.
 */
export function applyAnthropicRequestCacheBreakpoints(
  system: string | Array<Record<string, unknown>> | undefined,
  messages: AnthropicWireMessage[],
): { system: typeof system; messages: AnthropicWireMessage[] } {
  if (!anthropicCacheBreakpointsEnabled()) return { system, messages };

  const cacheable: CacheableBlock[] = [];
  const slots: WireSlot[] = [];
  const messagesOut: AnthropicWireMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => ({ ...b })),
  }));

  if (system !== undefined && system !== "") {
    if (typeof system === "string") {
      cacheable.push({ kind: "system", text: system });
      slots.push({ target: "system", blockIndex: 0 });
    } else {
      for (let i = 0; i < system.length; i++) {
        const block = system[i]!;
        cacheable.push({ kind: i === 0 ? "system" : "other", text: blockText(block) });
        slots.push({ target: "system", blockIndex: i });
      }
    }
  }

  for (let mi = 0; mi < messagesOut.length; mi++) {
    const msg = messagesOut[mi]!;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]!;
      slots.push({ target: "message", msgIndex: mi, blockIndex: bi });
      cacheable.push({ kind: cacheableKind(block, msg.role), text: blockText(block) });
    }
  }

  const planned = planCacheBreakpoints(cacheable, {
    enabled: true,
    route: "anthropic",
    stablePrefixLength: cacheableBlocksCutIndex(cacheable),
  });
  if (planned.length === 0) return { system, messages: messagesOut };

  let systemOut: typeof system = system;

  const systemPlanned = planned
    .map((p) => ({ p, slot: slots[p.index] }))
    .filter((x): x is { p: (typeof planned)[number]; slot: { target: "system"; blockIndex: number } } =>
      x.slot?.target === "system",
    );
  if (systemPlanned.length > 0) {
    if (typeof systemOut === "string") {
      const blocks = [{ type: "text", text: systemOut }];
      systemOut = applyCacheBreakpoints(
        blocks,
        systemPlanned.map(({ p }) => ({ ...p, index: 0 })),
      );
    } else if (Array.isArray(systemOut)) {
      systemOut = applyCacheBreakpoints(
        systemOut.map((b) => ({ ...b })),
        systemPlanned.map(({ p, slot }) => ({ ...p, index: slot.blockIndex })),
      );
    }
  }

  for (const p of planned) {
    const slot = slots[p.index];
    if (!slot || slot.target !== "message") continue;
    const block = messagesOut[slot.msgIndex]!.content[slot.blockIndex]!;
    if (block.type !== "text" && block.type !== "tool_result") continue;
    block.cache_control = p.cache_control;
  }

  return { system: systemOut, messages: messagesOut };
}

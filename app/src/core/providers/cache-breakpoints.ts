/**
 * cache-breakpoints.ts — reduced Anthropic cache-control planner (docs/30 B-4 / §7).
 *
 * Pure planner: up to BREAKPOINT_CAP ephemeral markers on content blocks. Off
 * unless `HZ_ANTHROPIC_CACHE_BREAKPOINTS=1` (applied on Anthropic wire via
 * `anthropic-cache-wire.ts`; keep-alive stub via `HZ_ANTHROPIC_CACHE_KEEPALIVE_MS`).
 * Optional `useCacheablePrefix` consults `cacheableMessagesPrefix` (ruling **276**).
 * Residual: live cache-hit measure still needs API keys (B-4).
 */

import type { ChatMsg } from "../../contracts";
import { cacheableMessagesCutIndex } from "./cacheable-messages-prefix";

export const BREAKPOINT_CAP = 4;

export type CacheRoute = "anthropic" | "openai" | "gemini" | "other";

/** Routes that skip explicit cache_control (provider-implicit caching). */
export function routeSkipsExplicitCache(route: CacheRoute): boolean {
  return route === "openai" || route === "gemini";
}

export interface CacheableBlock {
  /** Stable prefix first; tool-result tails advance later. */
  kind: "system" | "stable" | "tool_result" | "other";
  text: string;
}

export interface PlannedBreakpoint {
  index: number;
  kind: CacheableBlock["kind"];
  cache_control: { type: "ephemeral" };
}

/**
 * Pick up to BREAKPOINT_CAP block indexes for ephemeral cache markers.
 * Order: system → stable → largest tool_result prefix tails (newest first).
 */
export function planCacheBreakpoints(
  blocks: readonly CacheableBlock[],
  opts?: {
    route?: CacheRoute;
    enabled?: boolean;
    cap?: number;
    /** When set, `tool_result` breakpoints apply only to blocks with index `< stablePrefixLength`. */
    stablePrefixLength?: number;
  },
): PlannedBreakpoint[] {
  const enabled = opts?.enabled ?? process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS === "1";
  if (!enabled) return [];
  const route = opts?.route ?? "anthropic";
  if (routeSkipsExplicitCache(route)) return [];
  const cap = Math.max(0, Math.min(opts?.cap ?? BREAKPOINT_CAP, BREAKPOINT_CAP));
  if (cap === 0 || blocks.length === 0) return [];

  const out: PlannedBreakpoint[] = [];
  const take = (kind: CacheableBlock["kind"]) => {
    for (let i = 0; i < blocks.length && out.length < cap; i++) {
      if (blocks[i]!.kind !== kind) continue;
      if (out.some((p) => p.index === i)) continue;
      out.push({ index: i, kind, cache_control: { type: "ephemeral" } });
    }
  };
  take("system");
  take("stable");
  const prefixLen = opts?.stablePrefixLength;
  // Newest tool_result tails first (largest-prefix cacheable growth).
  const toolIdx = blocks
    .map((b, i) => (b.kind === "tool_result" ? i : -1))
    .filter((i) => i >= 0 && (prefixLen === undefined || i < prefixLen))
    .reverse();
  for (const i of toolIdx) {
    if (out.length >= cap) break;
    if (out.some((p) => p.index === i)) continue;
    out.push({ index: i, kind: "tool_result", cache_control: { type: "ephemeral" } });
  }
  return out;
}

/** Apply planned markers onto a shallow-copied block list as `cache_control`. */
export function applyCacheBreakpoints<T extends Record<string, unknown>>(
  blocks: readonly T[],
  planned: readonly PlannedBreakpoint[],
): T[] {
  if (planned.length === 0) return blocks.map((b) => ({ ...b }));
  const byIndex = new Map(planned.map((p) => [p.index, p.cache_control]));
  return blocks.map((b, i) => {
    const cc = byIndex.get(i);
    if (!cc) return { ...b };
    return { ...b, cache_control: cc };
  });
}

/** Map transcript rows to planner blocks (user text slabs → `stable`). */
export function chatMessagesToCacheableBlocks(messages: readonly ChatMsg[]): CacheableBlock[] {
  return messages.map((m) => ({
    kind: m.role === "tool" ? "tool_result" : m.role === "user" ? "stable" : "other",
    text: m.content ?? "",
  }));
}

/**
 * Planner over `ChatMsg[]`; when `useCacheablePrefix` is true, tool_result breakpoints
 * skip rows after the largest stable prefix (`cacheableMessagesPrefix`).
 */
export function planCacheBreakpointsForMessages(
  messages: readonly ChatMsg[],
  opts?: Parameters<typeof planCacheBreakpoints>[1] & { useCacheablePrefix?: boolean },
): PlannedBreakpoint[] {
  const blocks = chatMessagesToCacheableBlocks(messages);
  const stablePrefixLength = opts?.useCacheablePrefix ? cacheableMessagesCutIndex(messages) : opts?.stablePrefixLength;
  return planCacheBreakpoints(blocks, { ...opts, stablePrefixLength });
}

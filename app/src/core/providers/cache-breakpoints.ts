/**
 * cache-breakpoints.ts — reduced Anthropic cache-control planner (docs/30 B-4 / §7).
 *
 * Pure planner: up to BREAKPOINT_CAP ephemeral markers on content blocks. ON by
 * default with an explicit opt-out, matching the wire (docs/28 ruling 542):
 * `HZ_ANTHROPIC_CACHE_BREAKPOINTS=0` disables, `=1` forces on, unset means on.
 * The env semantics live here so the planner and the wire can never disagree
 * (D-11); `anthropic-cache-wire.ts` consumes this same helper.
 * Optional `useCacheablePrefix` consults `cacheableMessagesPrefix` (ruling **276**).
 * Residual: live cache-hit measure still needs API keys (B-4).
 */

import type { ChatMsg } from "../../contracts";
import { textFromChatContent } from "../chat-content";
import { cacheableMessagesCutIndex } from "./cacheable-messages-prefix";

export const BREAKPOINT_CAP = 4;

/**
 * D-11: the ONE env reading for Anthropic cache breakpoints. Unset/empty means
 * ON (product default, ruling 542); 0/false/off/no disables; 1/true/yes/on
 * forces on; any other value is treated as unset (ON) rather than as a silent
 * third state.
 */
export function cacheBreakpointsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HZ_ANTHROPIC_CACHE_BREAKPOINTS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return true;
}

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
  const enabled = opts?.enabled ?? cacheBreakpointsEnabled();
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
    text: textFromChatContent(m.content),
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

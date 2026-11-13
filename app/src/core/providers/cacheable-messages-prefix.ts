/**
 * Largest cacheable `ChatMsg[]` prefix (docs/30 B-4 / aider `cacheable_messages()` reduced).
 *
 * ADAPT opencode `cache-policy.ts` `messages: { tail: 1 }`: breakpoints (and
 * keep-alive pings) must not treat the volatile conversation tail as stable.
 * HorizonCode's transcript uses `role: "tool"` for tool results; the last such
 * message may still grow while a call is in flight or when output is truncated
 * with a resumable `nextOffset`.
 */

import type { ChatMsg } from "../../contracts";
import type { CacheableBlock } from "./cache-breakpoints";

const RESUMABLE_TRUNCATION = /\bnextOffset:\s*\d+/;

function toolResultTextMayStillGrow(content: string): boolean {
  if (content === "" || content === "(no output)") return true;
  if (RESUMABLE_TRUNCATION.test(content)) return true;
  return false;
}

/** Whether a stored tool result row may still gain bytes before the next provider call. */
export function toolResultMayStillGrow(msg: ChatMsg, index: number, messages: readonly ChatMsg[]): boolean {
  if (msg.role !== "tool") return false;
  if (index !== messages.length - 1) return false;
  return toolResultTextMayStillGrow(msg.content ?? "");
}

/**
 * Exclusive end index: `messages.slice(0, n)` is the longest prefix safe to treat as
 * byte-stable for cache markers / warming pings.
 */
export function cacheableMessagesCutIndex(messages: readonly ChatMsg[]): number {
  if (messages.length === 0) return 0;
  let lastTool = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "tool") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return messages.length;

  const lastToolMsg = messages[lastTool]!;
  if (toolResultMayStillGrow(lastToolMsg, lastTool, messages)) return lastTool;
  return messages.length;
}

/**
 * Exclusive end index on Anthropic wire `CacheableBlock[]` (system + message blocks).
 * Volatile trailing `tool_result` rows are excluded only when they are the transcript tail.
 */
export function cacheableBlocksCutIndex(blocks: readonly CacheableBlock[]): number {
  if (blocks.length === 0) return 0;
  let lastTool = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === "tool_result") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return blocks.length;
  if (lastTool < blocks.length - 1) return blocks.length;
  if (toolResultTextMayStillGrow(blocks[lastTool]!.text)) return lastTool;
  return blocks.length;
}

/** Longest `ChatMsg[]` prefix safe to mark cache-stable (aider `cacheable_messages()` shape). */
export function cacheableMessagesPrefix(messages: readonly ChatMsg[]): ChatMsg[] {
  const cut = cacheableMessagesCutIndex(messages);
  return messages.slice(0, cut);
}

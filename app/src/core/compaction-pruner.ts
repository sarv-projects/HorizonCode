/**
 * Compaction split reduced: trim oversized tool results in the elided prefix
 * BEFORE summarisation (no provider-backed summariser; no image offload).
 */

import type { ChatMsg } from "../contracts";
import { MAX_RESULT_BYTES } from "./output-budget";

export const PRUNED_TOOL_MARKER = "\n[compaction: tool result pruned before summary]\n";

export function pruneToolResultsForCompaction(messages: readonly ChatMsg[], maxBytes = MAX_RESULT_BYTES): ChatMsg[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = msg.content ?? "";
    if (content.length <= maxBytes) return msg;
    const head = content.slice(0, maxBytes);
    return { ...msg, content: `${head}${PRUNED_TOOL_MARKER}(was ${content.length} bytes)` };
  });
}

/**
 * Compaction split reduced: trim oversized tool results in the elided prefix
 * and active history before summarisation and provider transmission.
 */

import type { ChatMsg } from "../contracts";
import { textFromChatContent } from "./chat-content";
import { MAX_RESULT_BYTES } from "./output-budget";

export const PRUNED_TOOL_MARKER = "\n[compaction: tool result pruned before summary]\n";

/**
 * Head-tail preservation: keeps leading lines/context and trailing summary/errors,
 * inserting an omission marker in the center.
 */
export function headTailTruncate(
  text: string,
  maxChars = MAX_RESULT_BYTES,
  headRatio = 0.6,
  omissionMarker = PRUNED_TOOL_MARKER,
): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * headRatio);
  const tailLen = Math.max(0, maxChars - headLen);

  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(-tailLen) : "";
  const omitted = text.length - (head.length + tail.length);

  return `${head}${omissionMarker}(was ${text.length} bytes, omitted ${omitted} characters)\n${tail}`;
}

export function pruneToolResultsForCompaction(messages: readonly ChatMsg[], maxBytes = MAX_RESULT_BYTES): ChatMsg[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = textFromChatContent(msg.content);
    if (content.length <= maxBytes) return msg;
    return { ...msg, content: headTailTruncate(content, maxBytes) };
  });
}

/**
 * Trim an individual message's content to stay within a token ceiling.
 * Preserves non-text parts (e.g. image attachments).
 */
export function trimMessageTokens(msg: ChatMsg, maxTokens = 2000): ChatMsg {
  const maxChars = maxTokens * 4;
  if (typeof msg.content === "string") {
    if (msg.content.length <= maxChars) return msg;
    const marker = "\n\n[token-budget: message content trimmed]\n\n";
    return { ...msg, content: headTailTruncate(msg.content, maxChars, 0.6, marker) };
  }
  if (Array.isArray(msg.content)) {
    let modified = false;
    const parts = msg.content.map((part) => {
      if (part.type === "text" && part.text.length > maxChars) {
        modified = true;
        const marker = "\n\n[token-budget: text part trimmed]\n\n";
        return { ...part, text: headTailTruncate(part.text, maxChars, 0.6, marker) };
      }
      return part;
    });
    return modified ? { ...msg, content: parts } : msg;
  }
  return msg;
}

/**
 * Trim oversized messages in a history window for specified roles (defaults to tool).
 */
export function trimHistoryMessages(
  messages: readonly ChatMsg[],
  maxTokens = 2000,
  roles: readonly string[] = ["tool"],
): { messages: ChatMsg[]; trimmedCount: number } {
  let trimmedCount = 0;
  const out = messages.map((msg) => {
    if (roles.includes(msg.role)) {
      const trimmed = trimMessageTokens(msg, maxTokens);
      if (trimmed !== msg) {
        trimmedCount += 1;
        return trimmed;
      }
    }
    return msg;
  });
  return { messages: out, trimmedCount };
}

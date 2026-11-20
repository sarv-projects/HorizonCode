// H-4 / ruling 517 residual: type-only formatter seam (no runtime cycle back
// through the converter modules).
import type { ChatMsg, ChatMsgContent } from "../../contracts";
import { chatContentHasImage, textFromChatContent } from "../chat-content";
import type { MessageFormatter } from "./message-formatter";

/**
 * H-5 provider-shape util (ruling **495**): normalize an empty tool result to
 * the non-empty placeholder every adapter replays. Before this util the same
 * inline expression appeared in four adapters (openai / anthropic / google /
 * ollama message builders):
 *
 *   msg.content && msg.content !== "" ? msg.content : "(no output)"
 *
 * The placeholder is a documented wire sentinel — `cacheable-messages-prefix.ts`
 * already treats "(no output)" as an empty result. Pure, no loop, no I/O; kept
 * outside adapter SSE loops (same H-5 posture as rulings 67 / 199 / 469 / 477).
 */

/** Wire sentinel used when a tool produced no text. */
export const NO_TOOL_OUTPUT = "(no output)";

/** Non-empty string → itself; empty / missing / non-string → sentinel. */
export function toolResultContent(raw: unknown): string {
  if (typeof raw === "string" && raw !== "") return raw;
  if (Array.isArray(raw)) {
    const text = textFromChatContent(raw as ChatMsgContent);
    return text !== "" ? text : NO_TOOL_OUTPUT;
  }
  return NO_TOOL_OUTPUT;
}

/** True when a tool result should use multipart provider wire (images). */
export function toolResultIsMultipart(raw: unknown): raw is ChatMsgContent {
  if (typeof raw === "string" || raw === undefined || raw === null) return false;
  if (Array.isArray(raw)) return chatContentHasImage(raw as ChatMsgContent);
  return chatContentHasImage(raw as ChatMsgContent);
}

// H-4 / ruling 517 residual: a small pure seam at the point where tool results
// ("observations") are rendered into provider messages. When a non-default
// `formatMessageClass` formatter is configured, the dialect's
// `format_observation_messages` hook decides the wire payload; with no formatter
// this returns `undefined` so the caller keeps its native, byte-identical path.

/**
 * Render observation (tool-result) messages through the selected formatter.
 * `undefined` formatter → `undefined` (caller uses its native byte-identical
 * rendering). Pure, loop-free; streaming is untouched.
 */
export function formatObservationMessages(
  formatter: MessageFormatter | undefined,
  toolMessages: readonly ChatMsg[],
): readonly unknown[] | undefined {
  return formatter === undefined ? undefined : formatter.formatObservationMessages(toolMessages);
}

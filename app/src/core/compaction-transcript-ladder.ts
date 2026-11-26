/**
 * compaction-transcript-ladder.ts -- progressive transcript rungs
 * (plan Task 11). Pure seam; compactView remains the production path.
 * No contract change, no new event, no claim that dropped constraints were
 * regained beyond the explicitly pinned block.
 */

import type { ChatMsg } from "../contracts";
import { PINNED_HEADING, SUMMARY_HEADING } from "./compaction";
import type { CompactionGeneration } from "./compaction-generation";

/**
 * Full five-rung ladder (Tier 1 #11 / opencode whole→clipped→removed→user-only→omitted):
 *   full      = whole transcript
 *   summarized= clipped tail + pinned summary
 *   pinned    = removed tail, pinned constraints only
 *   user_only = only user-role messages + pinned constraints
 *   omitted   = no messages (dropped all; caller must end or fail the turn)
 */
export type TranscriptRung = "full" | "summarized" | "pinned" | "user_only" | "omitted";

export const TRANSCRIPT_LADDER: readonly TranscriptRung[] = [
  "full", "summarized", "pinned", "user_only", "omitted",
];

export interface ProgressiveTranscriptView {
  messages: ChatMsg[];
  rung: TranscriptRung;
  dropped: number;
}

function contentText(msg: ChatMsg): string {
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

function withAppendedText(msg: ChatMsg, blocks: readonly string[]): ChatMsg {
  const parts = [contentText(msg), ...blocks].filter((part) => part.trim() !== "");
  return { ...msg, content: parts.join("\n\n") };
}

export function progressiveTranscriptView(
  messages: readonly ChatMsg[],
  rungIndex: number,
  pinned: readonly string[],
  generation: CompactionGeneration,
): ProgressiveTranscriptView {
  const index = Math.min(TRANSCRIPT_LADDER.length - 1, Math.max(0, Math.floor(rungIndex)));
  const rung = TRANSCRIPT_LADDER[index] ?? "full";
  if (messages.length === 0) return { messages: [], rung, dropped: 0 };
  if (rung === "full") return { messages: messages as ChatMsg[], rung, dropped: 0 };
  if (rung === "omitted") {
    return { messages: [], rung, dropped: messages.length };
  }

  const firstUserIndex = messages.findIndex((m) => m.role === "user");
  const head: ChatMsg = firstUserIndex >= 0
    ? messages[firstUserIndex]!
    : { role: "user", content: "(conversation context)" };
  const pinnedBlock = pinned.length > 0
    ? `${PINNED_HEADING}\n${pinned.map((p) => `- ${p}`).join("\n")}`
    : "";
  const summaryBlock = `${SUMMARY_HEADING}\ngeneration ${generation.generation} (${generation.viewDigest}) for session ${generation.sessionId}`;
  const headWithBlocks = withAppendedText(head, [pinnedBlock, summaryBlock]);

  if (rung === "pinned") {
    return { messages: [headWithBlocks], rung, dropped: messages.length - 1 };
  }
  if (rung === "user_only") {
    const userMessages = messages.filter((m) => m.role === "user");
    const firstUser = userMessages[0];
    if (firstUser !== undefined && userMessages.length > 0) {
      userMessages[0] = withAppendedText(firstUser, [pinnedBlock, summaryBlock]);
    }
    return { messages: userMessages, rung, dropped: messages.length - userMessages.length };
  }

  // summarized: keep the first user turn plus a newest tail; never split an
  // assistant tool-call turn from its tool result by cutting inside a pair.
  const keepTail = index <= 1 ? Math.max(1, Math.ceil(messages.length * 0.4)) : 2;
  const keepIndices = new Set<number>();
  const headIndex = firstUserIndex >= 0 ? firstUserIndex : -1;
  if (headIndex >= 0) keepIndices.add(headIndex);
  const tailStart = messages.length - keepTail;
  for (let i = tailStart; i < messages.length; i += 1) {
    if (messages[i]!.role !== "tool") keepIndices.add(i);
  }
  const out: ChatMsg[] = [headWithBlocks];
  for (let i = tailStart; i < messages.length; i += 1) {
    if (i === headIndex || !keepIndices.has(i)) continue;
    out.push(messages[i]!);
  }
  return { messages: out, rung, dropped: Math.max(0, messages.length - out.length) };
}

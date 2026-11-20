/**
 * Token-aware history window (ruling **668**).
 *
 * Complements message-count `HISTORY_LIMIT`: when the estimated transcript is
 * large relative to the model context window, shrink the message window early;
 * when messages are short, allow more than the default count before compacting.
 * Deterministic — no LLM summarizer in this slice.
 */

import type { ChatMsg } from "../contracts";
import { chatContentText } from "./chat-content";
import { compactHistory, tokensIn, type CompactionOptions, type CompactionResult } from "./compaction";
import { estimateTokens } from "./output-budget";

/** Default message-count ceiling when the token budget is not binding. */
export const DEFAULT_HISTORY_MESSAGE_LIMIT = 80;
/** Hard ceiling even for tiny messages (KV / provider sanity). */
export const HISTORY_MESSAGE_HARD_CAP = 200;
/** Floor so compaction cannot collapse to an unusable stub. */
export const HISTORY_MESSAGE_FLOOR = 16;
/** Compact when estimated history tokens exceed this fraction of the window. */
export const HISTORY_TOKEN_PRESSURE = 0.7;

function messageTokens(msg: ChatMsg): number {
  let n = estimateTokens(chatContentText(msg.content));
  for (const call of msg.toolCalls ?? []) {
    n += estimateTokens(call.arguments ?? "");
  }
  return n;
}

/** Estimated tokens for a transcript slice (bytes/4 style via estimateTokens). */
export function estimateHistoryTokens(messages: readonly ChatMsg[]): number {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}

/**
 * Choose a message-count limit for `compactHistory` given the full transcript
 * and the catalog context window. Returns at least HISTORY_MESSAGE_FLOOR and
 * at most HISTORY_MESSAGE_HARD_CAP.
 */
export function tokenAwareHistoryLimit(
  messages: readonly ChatMsg[],
  contextWindowTokens: number,
  opts?: { defaultLimit?: number; pressure?: number },
): number {
  const defaultLimit = opts?.defaultLimit ?? DEFAULT_HISTORY_MESSAGE_LIMIT;
  const pressure = opts?.pressure ?? HISTORY_TOKEN_PRESSURE;
  const window = Math.max(1_024, Math.floor(contextWindowTokens));
  const budget = Math.floor(window * pressure);
  const total = estimateHistoryTokens(messages);
  if (messages.length === 0) return defaultLimit;

  // Under budget: allow growing past default when messages are short.
  if (total <= budget) {
    if (messages.length <= defaultLimit) return defaultLimit;
    // Short messages past default — keep all up to hard cap.
    return Math.min(HISTORY_MESSAGE_HARD_CAP, Math.max(defaultLimit, messages.length));
  }

  // Over budget: walk newest-first until we fit, then use that count as limit.
  let used = 0;
  let keep = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageTokens(messages[i]!);
    if (keep > 0 && used + t > budget) break;
    used += t;
    keep += 1;
    if (keep >= HISTORY_MESSAGE_HARD_CAP) break;
  }
  return Math.max(HISTORY_MESSAGE_FLOOR, Math.min(HISTORY_MESSAGE_HARD_CAP, keep || HISTORY_MESSAGE_FLOOR));
}

/** Provider-history token budget derived from the catalog context window. */
export function historyProviderTokenBudget(
  contextWindowTokens: number,
  pressure: number = HISTORY_TOKEN_PRESSURE,
): number {
  const window = Math.max(1_024, Math.floor(contextWindowTokens));
  return Math.floor(window * pressure);
}

/**
 * When the compacted provider view still exceeds the history budget, shrink
 * the message window and re-compact until it fits or hits the floor (ruling 729).
 */
export function compactHistoryWithTokenFit(
  messages: ChatMsg[],
  options: CompactionOptions,
  contextWindowTokens: number,
): { result: CompactionResult; limit: number; tokenFitApplied: boolean } {
  const budget = historyProviderTokenBudget(contextWindowTokens);
  let limit = options.limit;
  let result = compactHistory(messages, { ...options, limit });
  if (tokensIn(result.history) <= budget) {
    return { result, limit, tokenFitApplied: false };
  }
  let tokenFitApplied = false;
  while (tokensIn(result.history) > budget && limit > HISTORY_MESSAGE_FLOOR) {
    tokenFitApplied = true;
    limit -= 1;
    result = compactHistory(messages, { ...options, limit });
  }
  return { result, limit, tokenFitApplied };
}

/**
 * sync-messages.ts — B-5 reduced: longest byte-stable prefix truncation
 * (omp `AppendOnlyContextManager.syncMessages` spirit; docs/28 rulings 470, 482).
 *
 * When rewritten history would otherwise clear the whole log (forcing a full
 * provider re-prefill), keep the longest prefix whose per-message digests still
 * match and re-append only the diverged tail.
 *
 * Ruling **470**: pure `syncMessages` helper.
 * Ruling **482**: `ProviderHistorySync` cursor + main-loop wire after
 * compact/steer rewrite paths; `syncForkedHistory` for in-memory fork truncation.
 *
 * NOT in this slice: frozen StablePrefix fingerprint of system+tools,
 * full append-only log class, per-provider gate from data (`auto`).
 */

import type { ChatMsg } from "../contracts";
import { digestOf } from "./canon";

/**
 * Digest of wire-relevant `ChatMsg` fields only (role/content/tool*). Object
 * identity and non-contract keys do not participate — two equal wire messages
 * share a digest even when they are distinct objects.
 */
export function chatMessageDigest(msg: ChatMsg): string {
  const wire: Record<string, unknown> = {
    role: msg.role,
    content: msg.content ?? "",
  };
  if (msg.toolCallId !== undefined) wire.toolCallId = msg.toolCallId;
  if (msg.toolName !== undefined) wire.toolName = msg.toolName;
  if (msg.toolCalls !== undefined) wire.toolCalls = msg.toolCalls;
  return digestOf(wire);
}

/**
 * Exclusive end index: `previous.slice(0, n)` and `desired.slice(0, n)` are
 * byte-stable (same per-message digests).
 */
export function longestStablePrefixLength(
  previous: readonly ChatMsg[],
  desired: readonly ChatMsg[],
): number {
  const n = Math.min(previous.length, desired.length);
  let i = 0;
  for (; i < n; i += 1) {
    if (chatMessageDigest(previous[i]!) !== chatMessageDigest(desired[i]!)) break;
  }
  return i;
}

export type SyncMessagesKind = "identical" | "append" | "rewrite" | "compact";

export interface SyncMessagesResult {
  /** Synced history: previous prefix objects kept where digests match, then desired tail. */
  messages: ChatMsg[];
  /** Exclusive end index of the preserved prefix. */
  stablePrefixLength: number;
  kind: SyncMessagesKind;
}

function classifySync(
  previousLen: number,
  desiredLen: number,
  stablePrefixLength: number,
): SyncMessagesKind {
  if (stablePrefixLength === previousLen && desiredLen === previousLen) return "identical";
  if (stablePrefixLength === previousLen && desiredLen > previousLen) return "append";
  if (desiredLen < previousLen && stablePrefixLength === desiredLen) return "compact";
  return "rewrite";
}

/**
 * Truncate rewritten history to the longest byte-stable prefix of `previous`,
 * then append the diverged `desired` tail. Pure helper — does not mutate inputs.
 */
export function syncMessages(
  previous: readonly ChatMsg[],
  desired: readonly ChatMsg[],
): SyncMessagesResult {
  const stablePrefixLength = longestStablePrefixLength(previous, desired);
  const kind = classifySync(previous.length, desired.length, stablePrefixLength);
  const messages: ChatMsg[] = [
    ...previous.slice(0, stablePrefixLength),
    ...desired.slice(stablePrefixLength),
  ];
  return { messages, stablePrefixLength, kind };
}

/**
 * In-memory fork truncation: keep the first `keep` parent messages via
 * `syncMessages` (omp compact/rewrite posture). SessionStore still persists a
 * row copy; this helper is the provider-facing / test rewrite path.
 */
export function syncForkedHistory(
  parent: readonly ChatMsg[],
  keep: number,
): SyncMessagesResult {
  const n = Number.isFinite(keep) ? Math.max(0, Math.min(Math.floor(keep), parent.length)) : 0;
  return syncMessages(parent, parent.slice(0, n));
}

/**
 * Stateful sync cursor for the main loop (omp `AppendOnlyContextManager`
 * `syncMessages` call pattern without frozen StablePrefix).
 *
 * Across dispatches, compact / steer / fork-shaped rewrites preserve prior
 * prefix object identity where digests still match.
 */
export class ProviderHistorySync {
  #previous: ChatMsg[] = [];
  #last: SyncMessagesResult | null = null;

  /** Last sync result, if any. */
  last(): SyncMessagesResult | null {
    return this.#last;
  }

  /** Messages from the previous successful sync (empty before the first). */
  previous(): readonly ChatMsg[] {
    return this.#previous;
  }

  /** Seed the cursor (e.g. inherited fork prefix) without classifying a rewrite. */
  seed(messages: readonly ChatMsg[]): void {
    this.#previous = [...messages];
    this.#last = {
      messages: this.#previous,
      stablePrefixLength: this.#previous.length,
      kind: "identical",
    };
  }

  reset(): void {
    this.#previous = [];
    this.#last = null;
  }

  /**
   * Sync desired provider-facing history against the prior dispatch view.
   * Updates the cursor to the synced messages.
   */
  sync(desired: readonly ChatMsg[]): SyncMessagesResult {
    const result = syncMessages(this.#previous, desired);
    this.#previous = result.messages;
    this.#last = result;
    return result;
  }
}

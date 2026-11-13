/**
 * Hold-then-swap compaction (opencode §5.1 reduced, docs/30).
 *
 * A provider-backed background worker is out of scope; this module holds a
 * precomputed elision summary keyed to the elided prefix and swaps it in when
 * `compactHistory` runs. Call `prepareHold` after a cache-stable prefix is known
 * (sync stub: inject a test summariser or reuse `summariseElided`).
 *
 * Opt-in loop wire: `HZ_COMPACTION_HOLD=1`.
 */

import type { ChatMsg } from "../contracts";
import { summariseElided } from "./compaction";
import { pruneToolResultsForCompaction } from "./compaction-pruner";
import { canonicalJson, sha256Hex } from "./canon";

export const COMPACTION_HOLD_ENV = "HZ_COMPACTION_HOLD";

export type ElidedSummariser = (elided: readonly ChatMsg[], total: number, limit: number) => string;

export function compactionHoldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[COMPACTION_HOLD_ENV] === "1";
}

/** Stable fingerprint of the elided prefix (count + content hash). */
export function compactionHoldKey(elided: readonly ChatMsg[]): string {
  const pruned = pruneToolResultsForCompaction(elided);
  const digest = sha256Hex(canonicalJson(pruned.map((m) => ({ role: m.role, content: m.content ?? "" }))));
  return `${pruned.length}:${digest}`;
}

export class CompactionHoldBuffer {
  private held: { key: string; summary: string } | null = null;

  constructor(private readonly summarise: ElidedSummariser = summariseElided) {}

  /** Stage a summary for the next compaction that elides this prefix. */
  prepareHold(elided: readonly ChatMsg[], total: number, limit: number): void {
    const key = compactionHoldKey(elided);
    this.held = { key, summary: this.summarise(elided, total, limit) };
  }

  /** Held summary if the key matches; otherwise clears hold and returns null. */
  takeHeldSummary(elided: readonly ChatMsg[]): string | null {
    const key = compactionHoldKey(elided);
    if (this.held?.key !== key) return null;
    const summary = this.held.summary;
    this.held = null;
    return summary;
  }

  peekHeldSummary(): string | null {
    return this.held?.summary ?? null;
  }

  clear(): void {
    this.held = null;
  }
}

/**
 * Resolve the summary block for compaction: swap in a held summary when the
 * prefix matches; otherwise use the injected/default summariser.
 */
export function summariseElidedWithHold(
  elided: readonly ChatMsg[],
  total: number,
  limit: number,
  hold?: CompactionHoldBuffer,
  fallback: ElidedSummariser = summariseElided,
): { summary: string; holdSwap: boolean } {
  const held = hold?.takeHeldSummary(elided);
  if (held !== null) return { summary: held, holdSwap: true };
  return { summary: fallback(elided, total, limit), holdSwap: false };
}

/**
 * elided-journal-crosscheck.ts — I-2 live-elision cross-check.
 *
 * The `/tokens` table renders a compaction summary row from the in-memory
 * history. The durable `compactions.jsonl` ledger records the tokens actually
 * dropped at each compaction (`CompactionRecordV1.dropped`). Comparing the two
 * is a LOCAL, auditable cross-check: it does not require a provider invoice and
 * it catches a summary that silently stopped accounting for dropped turns.
 *
 * Provider invoice truth remains a separate, external residual (H-2/I-2).
 */

import type { CompactionRecordV1 } from "./compaction-journal";

export interface ElidedCrossCheckOptions {
  sessionId?: string;
  /** Absolute tolerance floor; default 32 tokens. */
  tolerance?: number;
  /** Relative tolerance of the summary size; default 5%. */
  relativeTolerance?: number;
}

export interface ElidedCrossCheck {
  summaryTokens: number;
  journalDropped: number;
  entries: number;
  delta: number;
  tolerance: number;
  reconciled: boolean;
  note: string;
}

/**
 * Compare one rendered compaction summary against the durable dropped-token
 * ledger. Multiple compaction records are summed (a summary can cover several
 * drops). A ledger with no matching records is NOT reconciled — it fails closed
 * rather than silently claiming parity.
 */
export function crossCheckElidedJournal(
  summaryTokens: number,
  records: readonly CompactionRecordV1[],
  opts: ElidedCrossCheckOptions = {},
): ElidedCrossCheck {
  const matching =
    opts.sessionId === undefined ? records : records.filter((r) => r.sessionId === opts.sessionId);
  const journalDropped = matching.reduce((sum, r) => sum + (Number.isFinite(r.dropped) ? Math.max(0, r.dropped) : 0), 0);
  const relative = opts.relativeTolerance ?? 0.05;
  const tolerance = Math.max(opts.tolerance ?? 32, Math.ceil(summaryTokens * relative));
  const delta = summaryTokens - journalDropped;
  const reconciled = matching.length > 0 && Math.abs(delta) <= tolerance;
  const note = matching.length === 0
    ? "no durable compaction record for this session — elision not reconciled"
    : reconciled
      ? `elided journal: ${matching.length} compaction(s) dropped ~${journalDropped} tokens; summary ~${summaryTokens} (Δ${delta >= 0 ? "+" : ""}${delta})`
      : `elided journal mismatch: summary ~${summaryTokens} vs dropped ~${journalDropped} (Δ${delta >= 0 ? "+" : ""}${delta}, tolerance ±${tolerance})`;
  return {
    summaryTokens,
    journalDropped,
    entries: matching.length,
    delta,
    tolerance,
    reconciled,
    note,
  };
}

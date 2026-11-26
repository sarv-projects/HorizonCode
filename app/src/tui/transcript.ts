/**
 * transcript.ts — session history export for /transcript pager (docs/13 D9 reduced)
 * and tail-first progressive mount budget (OpenCode 40/60 parity).
 */

import type { ChatMsg } from "../contracts";

/** Newest transcript rows mounted immediately on first paint. */
export const TRANSCRIPT_TAIL_ROWS = 40;
/** Older transcript rows backfilled per tick or scroll step. */
export const TRANSCRIPT_BACKFILL_CHUNK = 60;

/** First row index such that rows `[index, end)` spend at least `budget` weight. */
export function rowsBefore(weights: readonly number[], end: number, budget: number): number {
  let index = Math.max(0, Math.min(weights.length, Math.floor(end)));
  let spent = 0;
  const target = Math.max(0, budget);
  while (index > 0 && spent < target) {
    spent += Math.max(1, weights[--index] ?? 1);
  }
  return index;
}

/** End row index such that rows `[start, index)` spend at least `budget` weight. */
export function rowsAfter(weights: readonly number[], start: number, budget: number): number {
  let index = Math.max(0, Math.min(weights.length, Math.floor(start)));
  let spent = 0;
  const target = Math.max(0, budget);
  while (index < weights.length && spent < target) {
    spent += Math.max(1, weights[index++] ?? 1);
  }
  return index;
}

export interface TranscriptMountWindow<T> {
  readonly items: readonly T[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly total: number;
  readonly remainingOlder: number;
  readonly fullyMounted: boolean;
}

export interface TranscriptMountBudgetOptions {
  /** Initial tail rows mounted on first paint (default: TRANSCRIPT_TAIL_ROWS = 40). */
  tailRows?: number;
  /** Rows added per backfill step (default: TRANSCRIPT_BACKFILL_CHUNK = 60). */
  backfillChunk?: number;
}

export interface TranscriptMountBudget {
  readonly tailRows: number;
  readonly backfillChunk: number;
  /** Current number of newest rows budgeted for mounting. */
  mountedCount(): number;
  /** Slice the newest mounted window from `rows`. */
  slice<T>(rows: readonly T[]): TranscriptMountWindow<T>;
  /** Backfill one chunk of older rows (default 60). Returns true if budget expanded. */
  backfill(totalRows: number, chunk?: number): boolean;
  /** Expand in backfill chunks as needed to cover `scrollUp + viewportRows`. */
  ensureVisible(totalRows: number, scrollUp: number, viewportRows: number): boolean;
  /** Reset budget back to initial `tailRows` (e.g. on session switch). */
  reset(): void;
}

/** Slice the newest `mountedCount` rows from a transcript tail-first. */
export function sliceTranscriptTailFirst<T>(
  rows: readonly T[],
  mountedCount: number = TRANSCRIPT_TAIL_ROWS,
): TranscriptMountWindow<T> {
  const total = rows.length;
  const count = Math.max(0, Math.floor(mountedCount));
  const startIndex = Math.max(0, total - count);
  return {
    items: rows.slice(startIndex, total),
    startIndex,
    endIndex: total,
    total,
    remainingOlder: startIndex,
    fullyMounted: startIndex === 0,
  };
}

/**
 * Progressive tail-first transcript mount budget:
 * mounts the newest 40 rows immediately and backfills older rows in 60-row chunks.
 */
export function createTranscriptMountBudget(
  opts: TranscriptMountBudgetOptions = {},
): TranscriptMountBudget {
  const tailRows = Math.max(1, Math.floor(opts.tailRows ?? TRANSCRIPT_TAIL_ROWS));
  const backfillChunk = Math.max(1, Math.floor(opts.backfillChunk ?? TRANSCRIPT_BACKFILL_CHUNK));
  let mounted = tailRows;

  return {
    tailRows,
    backfillChunk,
    mountedCount: () => mounted,
    slice: <T>(rows: readonly T[]) => sliceTranscriptTailFirst(rows, mounted),
    backfill(totalRows, chunk = backfillChunk) {
      const total = Math.max(0, Math.floor(totalRows));
      if (mounted >= total) return false;
      const step = Math.max(1, Math.floor(chunk));
      mounted = Math.min(total, mounted + step);
      return true;
    },
    ensureVisible(totalRows, scrollUp, viewportRows) {
      const total = Math.max(0, Math.floor(totalRows));
      const needed = Math.min(total, Math.max(0, Math.floor(scrollUp)) + Math.max(1, Math.floor(viewportRows)));
      if (needed <= mounted || mounted >= total) return false;
      const steps = Math.ceil((needed - mounted) / backfillChunk);
      mounted = Math.min(total, mounted + steps * backfillChunk);
      return true;
    },
    reset() {
      mounted = tailRows;
    },
  };
}

export function formatTranscriptPlain(messages: readonly ChatMsg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role ?? "unknown";
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    lines.push(`## ${role}`);
    lines.push(text.trimEnd());
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

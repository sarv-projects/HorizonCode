/**
 * I-2 reduced (docs/30): per-chunk context cost table with $ estimates and
 * remediation hints (ADAPT aider `/tokens`).
 *
 * Ruling 461: compaction summary text in history is its own row (not folded
 * into user/assistant/tool), with harness $ from usage-cost rates. $ columns
 * remain harness estimates (priceTableRevision harness-v1) — not provider
 * invoice truth.
 */

import type { ChatMsg, ContextUsage } from "../contracts";
import { chatContentText } from "./chat-content";
import type { CompactionRecordV1 } from "./compaction-journal";
import { COMPACTION_SEPARATOR, SUMMARY_HEADING } from "./compaction";
import { crossCheckElidedJournal, type ElidedCrossCheck } from "./elided-journal-crosscheck";
import { estimateTokens } from "./output-budget";
import { HARNESS_PRICE_TABLE_REVISION, ratesForModel } from "./usage-cost";

export interface ContextChunkRow {
  label: string;
  tokens: number;
  usd?: number;
  hint?: string;
  /** Present when this row is the elided-turns compaction summary block. */
  kind?: "compaction";
  /** I-2: durable ledger cross-check for the compaction row, when supplied. */
  crossCheck?: ElidedCrossCheck;
}

/**
 * Pull the labelled compaction summary out of a merged user turn
 * (`pinned --- summary --- original`). Returns undefined when absent.
 */
export function extractCompactionSummary(content: string): string | undefined {
  const start = content.indexOf(SUMMARY_HEADING);
  if (start < 0) return undefined;
  const fromHeading = content.slice(start);
  const end = fromHeading.indexOf(COMPACTION_SEPARATOR);
  return end >= 0 ? fromHeading.slice(0, end) : fromHeading;
}

function usdForTokens(tokens: number, inputPerM: number): number {
  return (tokens / 1_000_000) * inputPerM;
}

export function contextChunkRows(
  history: readonly ChatMsg[],
  system: string,
  usage: ContextUsage | undefined,
  provider: string,
  /** Optional durable elision ledger (I-2); no extra I/O by default. */
  compactionLedger?: readonly CompactionRecordV1[],
  compactionSessionId?: string,
): ContextChunkRow[] {
  const rates = ratesForModel(provider, usage?.model ?? "");
  const rows: ContextChunkRow[] = [];

  const sysTok = estimateTokens(system);
  rows.push({
    label: "system rail",
    tokens: sysTok,
    usd: usdForTokens(sysTok, rates.inputPerM),
    hint: sysTok > 8_000 ? "trim instructions or use /context to review rails" : undefined,
  });

  let user = 0;
  let assistant = 0;
  let tool = 0;
  let compaction = 0;
  let compactionBlocks = 0;
  for (const m of history) {
    const content = chatContentText(m.content);
    const summary = extractCompactionSummary(content);
    let remainder = content;
    if (summary !== undefined) {
      compaction += estimateTokens(summary);
      compactionBlocks += 1;
      remainder = content.replace(summary, "");
    }
    const t = estimateTokens(remainder + JSON.stringify(m.toolCalls ?? []));
    if (m.role === "user") user += t;
    else if (m.role === "assistant") assistant += t;
    else tool += t;
  }
  if (compaction > 0) {
    const crossCheck =
      compactionLedger === undefined
        ? undefined
        : crossCheckElidedJournal(compaction, compactionLedger, { sessionId: compactionSessionId });
    rows.push({
      label: compactionBlocks === 1 ? "compaction summary" : `compaction summary (×${compactionBlocks})`,
      tokens: compaction,
      usd: usdForTokens(compaction, rates.inputPerM),
      kind: "compaction",
      hint:
        crossCheck !== undefined
          ? crossCheck.note
          : compaction > 4_000
            ? "elided-turn summary is large; /rewind or raise compaction limit"
            : "elided turns replaced by this labelled summary",
      ...(crossCheck !== undefined ? { crossCheck } : {}),
    });
  }
  if (user > 0) rows.push({ label: "user turns", tokens: user, usd: usdForTokens(user, rates.inputPerM) });
  if (assistant > 0) {
    rows.push({
      label: "assistant turns",
      tokens: assistant,
      usd: usdForTokens(assistant, rates.inputPerM),
      hint: assistant > 12_000 ? "compaction or /rewind may shrink history" : undefined,
    });
  }
  if (tool > 0) {
    rows.push({
      label: "tool results",
      tokens: tool,
      usd: usdForTokens(tool, rates.inputPerM),
      hint: tool > 20_000 ? "prefer smaller reads; check spills" : undefined,
    });
  }

  if (usage !== undefined) {
    rows.push({
      label: "next dispatch (est.)",
      tokens: usage.estimatedInput,
      hint:
        usage.estimatedInput > usage.window * 0.85
          ? `near context window (${usage.window}); reduce history or raise compaction`
          : undefined,
    });
    rows.push({ label: "fitted max output", tokens: usage.maxOutput });
  }

  return rows;
}

export function renderContextTokenTable(rows: readonly ContextChunkRow[]): string {
  const lines = [
    `context chunks (harness estimates; ${HARNESS_PRICE_TABLE_REVISION}; not provider invoice):`,
    "chunk | ~tokens | ~$ | hint",
  ];
  for (const row of rows) {
    const usd = row.usd !== undefined ? `$${row.usd.toFixed(4)}` : "—";
    const hint = row.hint ?? "";
    lines.push(`${row.label} | ${row.tokens.toLocaleString("en-US")} | ${usd} | ${hint}`);
  }
  return lines.join("\n");
}

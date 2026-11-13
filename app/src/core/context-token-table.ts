/**
 * I-2 reduced (docs/30): per-chunk context cost table with $ estimates and
 * remediation hints (ADAPT aider `/tokens`).
 */

import type { ChatMsg, ContextUsage } from "../contracts";
import { estimateTokens } from "./output-budget";
import { ratesForModel } from "./usage-cost";

export interface ContextChunkRow {
  label: string;
  tokens: number;
  usd?: number;
  hint?: string;
}

export function contextChunkRows(
  history: readonly ChatMsg[],
  system: string,
  usage: ContextUsage | undefined,
  provider: string,
): ContextChunkRow[] {
  const rates = ratesForModel(provider, usage?.model ?? "");
  const rows: ContextChunkRow[] = [];

  const sysTok = estimateTokens(system);
  rows.push({
    label: "system rail",
    tokens: sysTok,
    usd: (sysTok / 1_000_000) * rates.inputPerM,
    hint: sysTok > 8_000 ? "trim instructions or use /context to review rails" : undefined,
  });

  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const m of history) {
    const t = estimateTokens((m.content ?? "") + JSON.stringify(m.toolCalls ?? []));
    if (m.role === "user") user += t;
    else if (m.role === "assistant") assistant += t;
    else tool += t;
  }
  if (user > 0) rows.push({ label: "user turns", tokens: user, usd: (user / 1_000_000) * rates.inputPerM });
  if (assistant > 0) {
    rows.push({
      label: "assistant turns",
      tokens: assistant,
      usd: (assistant / 1_000_000) * rates.inputPerM,
      hint: assistant > 12_000 ? "compaction or /rewind may shrink history" : undefined,
    });
  }
  if (tool > 0) {
    rows.push({
      label: "tool results",
      tokens: tool,
      usd: (tool / 1_000_000) * rates.inputPerM,
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
  const lines = ["context chunks (local estimates):", "chunk | ~tokens | ~$ | hint"];
  for (const row of rows) {
    const usd = row.usd !== undefined ? `$${row.usd.toFixed(4)}` : "—";
    const hint = row.hint ?? "";
    lines.push(`${row.label} | ${row.tokens.toLocaleString("en-US")} | ${usd} | ${hint}`);
  }
  return lines.join("\n");
}

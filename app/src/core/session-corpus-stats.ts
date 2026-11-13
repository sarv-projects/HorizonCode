/**
 * J-5 reduced: analyse session/post-mortem corpus for tool usage histograms
 * (omp session-stats idea; read-only, no optimiser scripts).
 */

import type { PostmortemRecord } from "./postmortem";

export interface ToolCallHistogram {
  tool: string;
  count: number;
}

export interface SessionCorpusSummary {
  records: number;
  terminals: Record<string, number>;
  tools: ToolCallHistogram[];
}

export function histogramFromPostmortems(records: readonly PostmortemRecord[]): SessionCorpusSummary {
  const terminals: Record<string, number> = {};
  const toolCounts = new Map<string, number>();
  for (const pm of records) {
    const term = pm.terminal ?? "unknown";
    terminals[term] = (terminals[term] ?? 0) + 1;
    const tools = pm.toolCalls ?? {};
    for (const [name, count] of Object.entries(tools)) {
      if (typeof count !== "number" || count < 1) continue;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
    }
  }
  const tools = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  return { records: records.length, terminals, tools };
}

export function renderSessionCorpusSummary(summary: SessionCorpusSummary): string {
  const lines = [`session corpus: ${summary.records} post-mortem(s)`];
  const termParts = Object.entries(summary.terminals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  if (termParts.length > 0) lines.push(`terminals: ${termParts.join(", ")}`);
  if (summary.tools.length > 0) {
    lines.push("tools:");
    for (const row of summary.tools.slice(0, 24)) {
      lines.push(`  ${row.tool}: ${row.count}`);
    }
    if (summary.tools.length > 24) lines.push(`  … +${summary.tools.length - 24} more`);
  } else {
    lines.push("tools: (none recorded)");
  }
  return lines.join("\n");
}

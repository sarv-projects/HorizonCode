/**
 * J-5: analyse the session/post-mortem corpus for tool usage histograms and
 * emit concrete tool/prompt tuning suggestions (omp session-stats idea).
 * Pure and read-only: suggestions are derived only from already-loaded
 * PostmortemRecord data, no session file is mutated and no network is used.
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

/* ---------------------- transcript optimiser suggestions (J-5) ---------------------- */

/** Thresholds are exported so tests and callers can state the rule, not guess it. */
export const TUNING_MIN_RECORDS = 3;
export const TUNING_FAILURE_RATE = 0.5;
export const TUNING_DOMINANT_TOOL_RATE = 0.6;
export const TUNING_MIN_TOOL_CALLS = 10;
export const TUNING_MIN_SHELL_CALLS = 5;

export type TuningArea = "tool" | "prompt" | "telemetry";

export interface TuningSuggestion {
  /** Stable id (sorted by priority then id for deterministic output). */
  id: string;
  area: TuningArea;
  severity: "info" | "warn";
  /** Short label. */
  title: string;
  /** Concrete, actionable instruction naming the observed counts. */
  detail: string;
  /** Lower sorts first. */
  priority: number;
}

export interface CorpusTuningReport {
  summary: SessionCorpusSummary;
  suggestions: TuningSuggestion[];
}

function failureClassCounts(records: readonly PostmortemRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const pm of records) {
    const name = typeof pm.failureClass === "string" ? pm.failureClass : "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Derive concrete tool/prompt tuning suggestions from a loaded corpus.
 * Every suggestion cites an observed count and a threshold; nothing writes to
 * a session, nor calls the network. Deterministic for a given record list.
 */
export function suggestCorpusTuning(records: readonly PostmortemRecord[]): CorpusTuningReport {
  const summary = histogramFromPostmortems(records);
  const suggestions: TuningSuggestion[] = [];
  const totalCalls = summary.tools.reduce((sum, row) => sum + row.count, 0);
  const top = summary.tools[0];
  const failed = summary.terminals.failed ?? 0;
  const unknown = summary.terminals.unknown ?? 0;
  const classes = failureClassCounts(records);
  const dominantClass = classes[0];

  if (summary.tools.length === 0) {
    suggestions.push({
      id: "tool-telemetry",
      area: "telemetry",
      severity: "info",
      title: "no tool-call telemetry",
      detail:
        "No post-mortem records toolCalls. Record a name→count map on each post-mortem before tuning tools; histograms and suggestions are unavailable without it.",
      priority: 10,
    });
  } else {
    if (top !== undefined && totalCalls >= TUNING_MIN_TOOL_CALLS && top.count / totalCalls >= TUNING_DOMINANT_TOOL_RATE) {
      const pct = Math.round((top.count / totalCalls) * 100);
      suggestions.push({
        id: "dominant-tool",
        area: "tool",
        severity: "warn",
        title: `dominant tool: ${top.tool}`,
        detail: `${top.tool} is ${top.count}/${totalCalls} tool calls (${pct}%, ≥ ${Math.round(TUNING_DOMINANT_TOOL_RATE * 100)}%). Batch or scope its calls (range reads, one grep over many) and add a prompt line steering the model to a more targeted tool.`,
        priority: 20,
      });
    }
    const shell = summary.tools.find((row) => row.tool === "shell");
    if (shell !== undefined && shell.count >= TUNING_MIN_SHELL_CALLS) {
      suggestions.push({
        id: "shell-heavy",
        area: "tool",
        severity: "info",
        title: "shell-heavy corpus",
        detail: `shell has ${shell.count} calls (≥ ${TUNING_MIN_SHELL_CALLS}). Prefer dedicated read/grep/glob tools for inspection and reserve shell for mutations; tighten the shell tool prompt accordingly.`,
        priority: 30,
      });
    }
  }

  if (records.length >= TUNING_MIN_RECORDS && failed / records.length >= TUNING_FAILURE_RATE) {
    const cls = dominantClass === undefined ? "unknown" : `${dominantClass[0]} (${dominantClass[1]})`;
    suggestions.push({
      id: "high-failure-rate",
      area: "prompt",
      severity: "warn",
      title: "high failure rate",
      detail: `${failed}/${records.length} post-mortems ended 'failed' (≥ ${Math.round(TUNING_FAILURE_RATE * 100)}%), dominant failure class ${cls}. Add a corrective prompt guard for that class and tune the responsible tool's retry/limit settings.`,
      priority: 15,
    });
  }
  if (dominantClass !== undefined && dominantClass[1] >= 2 && dominantClass[0] === "tool_error") {
    suggestions.push({
      id: "tool-error-class",
      area: "tool",
      severity: "warn",
      title: "tool_error failures",
      detail: `${dominantClass[1]} post-mortems are failure class tool_error. Audit the failing tool's schema/validation and add a prompt hint with one valid invocation example.`,
      priority: 25,
    });
  }
  if (dominantClass !== undefined && dominantClass[1] >= 2 && dominantClass[0] === "budget") {
    suggestions.push({
      id: "budget-class",
      area: "prompt",
      severity: "info",
      title: "budget failures",
      detail: `${dominantClass[1]} post-mortems are failure class budget. Tighten the output budget / compaction prompt and lower per-turn tool result caps.`,
      priority: 35,
    });
  }
  if (unknown > 0) {
    suggestions.push({
      id: "unknown-terminal",
      area: "telemetry",
      severity: "info",
      title: "unclassified terminals",
      detail: `${unknown} post-mortem(s) ended 'unknown'. Improve terminal classification at the source so tuning signals are not diluted.`,
      priority: 40,
    });
  }

  suggestions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { summary, suggestions };
}

/** Human-readable optimiser report (summary + concrete suggestions). */
export function renderCorpusTuningReport(report: CorpusTuningReport): string {
  const lines = [renderSessionCorpusSummary(report.summary), ""];
  if (report.suggestions.length === 0) {
    lines.push("tuning suggestions: (none — corpus looks tuned)");
    return lines.join("\n");
  }
  lines.push(`tuning suggestions (${report.suggestions.length}):`);
  for (const s of report.suggestions) {
    lines.push(`  [${s.severity}/${s.area}] ${s.title}`);
    lines.push(`    ${s.detail}`);
  }
  return lines.join("\n");
}

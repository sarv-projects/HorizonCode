/**
 * J-4 reduced: typed metric definitions and arms grouped by job id prefix.
 * Resume semantics reuse J-2 JSONL (`batch-runner.ts`); no full metaharness port.
 */

import type { BatchJobRow } from "./batch-runner";

export interface BenchmarkMetricDef {
  name: string;
  unit: string;
  description: string;
}

export const DEFAULT_BENCHMARK_METRICS: BenchmarkMetricDef[] = [
  { name: "pass_rate", unit: "ratio", description: "Fraction of rows with status done" },
  { name: "fail_rate", unit: "ratio", description: "Fraction of rows with status failed" },
  { name: "pending", unit: "count", description: "Rows still pending or stale running" },
];

/** Arm = substring before the first `-` in the job id, or the whole id. */
export function armPrefixFromJobId(id: string): string {
  const trimmed = id.trim();
  const dash = trimmed.indexOf("-");
  return dash > 0 ? trimmed.slice(0, dash) : trimmed;
}

export function groupRowsByArm(rows: readonly BatchJobRow[]): Map<string, BatchJobRow[]> {
  const map = new Map<string, BatchJobRow[]>();
  for (const row of rows) {
    const arm = armPrefixFromJobId(row.id);
    const list = map.get(arm) ?? [];
    list.push(row);
    map.set(arm, list);
  }
  return map;
}

export interface ArmSummary {
  arm: string;
  total: number;
  done: number;
  failed: number;
  pending: number;
}

export function summarizeArms(rows: readonly BatchJobRow[]): ArmSummary[] {
  const grouped = groupRowsByArm(rows);
  const out: ArmSummary[] = [];
  for (const [arm, list] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let done = 0;
    let failed = 0;
    let pending = 0;
    for (const row of list) {
      if (row.status === "done") done += 1;
      else if (row.status === "failed") failed += 1;
      else pending += 1;
    }
    out.push({ arm, total: list.length, done, failed, pending });
  }
  return out;
}

export function formatBenchmarkManagerReport(rows: readonly BatchJobRow[]): string {
  const arms = summarizeArms(rows);
  if (arms.length === 0) return "benchmark: no rows";
  const metrics = DEFAULT_BENCHMARK_METRICS.map((m) => m.name).join(", ");
  const lines = [`benchmark metrics: ${metrics}`, "arms:"];
  for (const a of arms) {
    const pass = a.total > 0 ? (a.done / a.total).toFixed(2) : "0.00";
    lines.push(`  ${a.arm}: ${a.done}/${a.total} done (pass_rate≈${pass}), ${a.failed} failed, ${a.pending} pending`);
  }
  return lines.join("\n");
}

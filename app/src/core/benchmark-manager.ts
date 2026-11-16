/**
 * J-4 reduced: typed metric definitions and arms grouped by job id prefix.
 * Resume-without-re-spec recovers launch flags (including `--arm`) from the
 * J-2/466 `*.runner-config.json` sidecar — no full omp metaharness port.
 */

import {
  armPrefixFromJobId,
  assertRunnerConfigMatchesJob,
  loadBatchJob,
  loadBatchRunnerConfig,
  resolveBatchSelectionForResume,
  selectBatchRows,
  selectionFromRunnerConfig,
  type BatchJobRow,
  type BatchSelectionOptions,
} from "./batch-runner";

export { armPrefixFromJobId };

export interface BenchmarkMetricDef {
  /** Stable metric key (omp MetricDefinition.key spirit). */
  key: string;
  label: string;
  format: "ratio" | "count";
  higherIsBetter: boolean;
  description: string;
}

export const DEFAULT_BENCHMARK_METRICS: BenchmarkMetricDef[] = [
  {
    key: "pass_rate",
    label: "Pass rate",
    format: "ratio",
    higherIsBetter: true,
    description: "Fraction of rows with status done",
  },
  {
    key: "fail_rate",
    label: "Fail rate",
    format: "ratio",
    higherIsBetter: false,
    description: "Fraction of rows with status failed",
  },
  {
    key: "pending",
    label: "Pending",
    format: "count",
    higherIsBetter: false,
    description: "Rows still pending or stale running",
  },
];

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
  /** Linear pass projection treating pending as not-yet-done (omp in-flight spirit). */
  projectedPassRate: number;
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
    const total = list.length;
    const projectedPassRate = total > 0 ? done / total : 0;
    out.push({ arm, total, done, failed, pending, projectedPassRate });
  }
  return out;
}

export function formatBenchmarkManagerReport(rows: readonly BatchJobRow[]): string {
  const arms = summarizeArms(rows);
  if (arms.length === 0) return "benchmark: no rows";
  const metrics = DEFAULT_BENCHMARK_METRICS.map((m) => m.key).join(", ");
  const lines = [`benchmark metrics: ${metrics}`, "arms:"];
  for (const a of arms) {
    const pass = a.projectedPassRate.toFixed(2);
    lines.push(
      `  ${a.arm}: ${a.done}/${a.total} done (pass_rate≈${pass}), ${a.failed} failed, ${a.pending} pending`,
    );
  }
  return lines.join("\n");
}

export interface ResumedBenchmarkStatus {
  selection: BatchSelectionOptions;
  rows: BatchJobRow[];
  arms: ArmSummary[];
  report: string;
  configPath: string;
}

/**
 * J-4 resume-without-re-spec: load a 466 runner-config sidecar, recover selection
 * (filter/arm/shuffle/slice), and produce the arm metric report for that subset.
 */
export function resumeBenchmarkFromRunnerConfig(args: {
  jobPath: string;
  configPath: string;
  cli?: BatchSelectionOptions;
}): ResumedBenchmarkStatus {
  const snap = loadBatchRunnerConfig(args.configPath);
  assertRunnerConfigMatchesJob(snap, args.jobPath);
  const selection = resolveBatchSelectionForResume(
    selectionFromRunnerConfig(snap),
    args.cli ?? {},
  );
  const load = loadBatchJob(args.jobPath);
  if (load.corrupt.length > 0) {
    throw new Error(`benchmark resume: ${load.corrupt.length} corrupt line(s) in ${args.jobPath}`);
  }
  const rows = selectBatchRows(load.rows, selection);
  return {
    selection,
    rows,
    arms: summarizeArms(rows),
    report: formatBenchmarkManagerReport(rows),
    configPath: args.configPath,
  };
}

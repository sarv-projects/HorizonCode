/**
 * J-4 reduced: typed metric definitions and arms grouped by job id prefix.
 * Resume-without-re-spec recovers launch flags (including `--arm`) from the
 * J-2/466 `*.runner-config.json` sidecar — no full omp metaharness port.
 */

import { metricContract } from "./metrics";
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

/* ---- typed omp metaharness adapters (metric key → row computation) ---- */

/** The closed set of typed metric keys this manager can compute. */
export type OmpMetricKey =
  | "pass_rate"
  | "fail_rate"
  | "pending"
  | "done"
  | "failed"
  | "total"
  | "projected_pass_rate"
  | "projected_fail_rate";

export function isOmpMetricKey(key: string): key is OmpMetricKey {
  return Object.prototype.hasOwnProperty.call(OMP_METRIC_ADAPTERS, key);
}

/**
 * A linear in-flight projection: pending rows are resolved in the SAME
 * proportion as the already-observed done:failed split. When nothing has
 * settled yet the projection is honestly unresolved (`basis: "none"`, 0 rate)
 * — no 50% coin-flip is invented. This goes beyond the simple
 * "pending counts as not-done" `projectedPassRate` on `ArmSummary`.
 */
export interface InFlightProjection {
  total: number;
  done: number;
  failed: number;
  pending: number;
  observedPassRate: number;
  projectedPassRate: number;
  projectedFailRate: number;
  basis: "none" | "observed";
}

export function inFlightProjection(rows: readonly BatchJobRow[]): InFlightProjection {
  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const total = rows.length;
  const pending = total - done - failed;
  const observed = done + failed;
  const observedPassRate = total > 0 ? done / total : 0;
  if (observed === 0) {
    return { total, done, failed, pending, observedPassRate, projectedPassRate: 0, projectedFailRate: 0, basis: "none" };
  }
  const projectedDone = done + pending * (done / observed);
  const projectedFailed = failed + pending * (failed / observed);
  return {
    total,
    done,
    failed,
    pending,
    observedPassRate,
    projectedPassRate: total > 0 ? projectedDone / total : 0,
    projectedFailRate: total > 0 ? projectedFailed / total : 0,
    basis: "observed",
  };
}

/** Typed adapters from job rows to a metric value — the omp metaharness seam. */
export const OMP_METRIC_ADAPTERS: Record<OmpMetricKey, (rows: readonly BatchJobRow[]) => number> = {
  total: (rows) => rows.length,
  done: (rows) => rows.filter((r) => r.status === "done").length,
  failed: (rows) => rows.filter((r) => r.status === "failed").length,
  pending: (rows) => rows.filter((r) => r.status !== "done" && r.status !== "failed").length,
  pass_rate: (rows) => (rows.length > 0 ? rows.filter((r) => r.status === "done").length / rows.length : 0),
  fail_rate: (rows) => (rows.length > 0 ? rows.filter((r) => r.status === "failed").length / rows.length : 0),
  projected_pass_rate: (rows) => inFlightProjection(rows).projectedPassRate,
  projected_fail_rate: (rows) => inFlightProjection(rows).projectedFailRate,
};

export interface TypedMetricValue {
  key: string;
  label: string;
  value: number;
  formatted: string;
  format: BenchmarkMetricDef["format"];
  higherIsBetter: boolean;
}

export function formatTypedMetric(value: number, format: BenchmarkMetricDef["format"]): string {
  return format === "ratio" ? value.toFixed(4) : String(Math.round(value));
}

/** Evaluate one typed metric definition against rows. Unknown keys refuse. */
export function computeBenchmarkMetric(def: BenchmarkMetricDef, rows: readonly BatchJobRow[]): TypedMetricValue {
  if (def === null || typeof def !== "object" || !isOmpMetricKey(def.key)) {
    throw new Error(`benchmark manager: unknown metric key ${JSON.stringify(def?.key)} — a typed adapter is required`);
  }
  const value = OMP_METRIC_ADAPTERS[def.key](rows);
  return {
    key: def.key,
    label: def.label,
    value,
    formatted: formatTypedMetric(value, def.format),
    format: def.format,
    higherIsBetter: def.higherIsBetter,
  };
}

/** The typed adapter for every shipped metric definition. */
export function computeDefaultBenchmarkMetrics(rows: readonly BatchJobRow[]): TypedMetricValue[] {
  return DEFAULT_BENCHMARK_METRICS.map((def) => computeBenchmarkMetric(def, rows));
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

/**
 * H-7: every number the benchmark manager reports has a contracted form. The
 * human `formatBenchmarkManagerReport` text is unchanged; this parallel surface
 * lets a consumer prove each number carries Metric/Anchor/Population/Excludes.
 */
export function benchmarkManagerPublication(rows: readonly BatchJobRow[]): string[] {
  const arms = summarizeArms(rows);
  const total = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const pending = total - done - failed;
  const passRate = total > 0 ? done / total : 0;
  const anchor = "none — first benchmark-manager report (no prior run to compare against)";
  const population = `${total} batch row(s) grouped into ${arms.length} arm(s) by job-id prefix`;
  const excludes = "none — every selected row is counted; pending/stale-running rows are not discarded";
  return [
    metricContract({ metric: "benchmark arms", anchor, population, excludes, value: arms.length }),
    metricContract({ metric: "benchmark rows total", anchor, population, excludes, value: total }),
    metricContract({ metric: "benchmark rows done / failed / pending", anchor, population, excludes, value: `${done} / ${failed} / ${pending}` }),
    metricContract({ metric: "benchmark projected pass rate", anchor, population, excludes, value: passRate.toFixed(4) }),
  ];
}

export interface ResumedBenchmarkStatus {
  selection: BatchSelectionOptions;
  rows: BatchJobRow[];
  arms: ArmSummary[];
  report: string;
  configPath: string;
  /** H-7: contracted numeric facts about this report. */
  published: string[];
  /** J-4: typed metric values computed by the omp adapters for this subset. */
  metrics: TypedMetricValue[];
  /** J-4: linear in-flight projection beyond the simple projectedPassRate. */
  projection: InFlightProjection;
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
    published: benchmarkManagerPublication(rows),
    metrics: computeDefaultBenchmarkMetrics(rows),
    projection: inFlightProjection(rows),
  };
}

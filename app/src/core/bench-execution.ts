/**
 * bench-execution.ts — J-4: bounded adapter that maps benchmark ARMS onto
 * batch-runner rows and REUSES `executeBatchJob` (the real per-row engine),
 * with the guarded runtime injected. No changes to batch-runner.ts.
 *
 * Typed metrics come from benchmark-manager.ts's omp adapters; resume semantics
 * are the batch engine's structural skip of done/failed rows, plus the arm id
 * stability that makes a second call a no-op. The full upstream metaharness is
 * external — this is only the shared execution seam.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  appendBatchJobRows,
  executeBatchJob,
  loadBatchJob,
  selectBatchRows,
  type BatchExecutionEvent,
  type BatchExecutionSummary,
  type BatchJobRow,
  type BatchRowExecutor,
  type BatchSpendRail,
} from "./batch-runner";
import {
  DEFAULT_BENCHMARK_METRICS,
  benchmarkManagerPublication,
  computeBenchmarkMetric,
  inFlightProjection,
  summarizeArms,
  type ArmSummary,
  type BenchmarkMetricDef,
  type InFlightProjection,
  type TypedMetricValue,
} from "./benchmark-manager";

export const MAX_BENCHMARK_ARMS = 32;
export const MAX_ROWS_PER_ARM = 1000;
export const MAX_BENCHMARK_ROWS = 4096;

/** One benchmark arm: a stable name (the job-id prefix) and its task list. */
export interface BenchmarkArmSpec {
  /** Stable arm prefix — no `-` (batch-runner derives arms before the first `-`). */
  arm: string;
  /** Task texts; row ids are `<arm>-<1-based index>`, stable across resumes. */
  tasks: readonly string[];
}

export interface ExecuteBenchmarkArmsOptions {
  /** JSONL batch job file: the durable resume source and execution ledger. */
  file: string;
  arms: readonly BenchmarkArmSpec[];
  /** The injected guarded per-row runtime (reused verbatim by executeBatchJob). */
  execute: BatchRowExecutor;
  /** Restrict execution to one arm (reuses batch-runner `selectBatchRows`). */
  arm?: string;
  spend?: BatchSpendRail;
  reserveUsd?: number;
  signal?: AbortSignal;
  concurrency?: number;
  onEvent?: (event: BatchExecutionEvent) => void;
  /** Typed metric definitions; defaults to the shipped omp adapters. */
  metricDefs?: readonly BenchmarkMetricDef[];
}

export interface BenchmarkArmsResult extends BatchExecutionSummary {
  /** Final on-disk rows after execution (the resume source for the next call). */
  rows: BatchJobRow[];
  /** Typed metric values — computed only by registered omp adapters. */
  metrics: TypedMetricValue[];
  arms: ArmSummary[];
  projection: InFlightProjection;
  /** H-7 contracted numeric facts about this report. */
  published: string[];
}

function validateArms(arms: readonly BenchmarkArmSpec[]): void {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error("benchmark execution: at least one arm is required");
  }
  if (arms.length > MAX_BENCHMARK_ARMS) {
    throw new Error(`benchmark execution: at most ${MAX_BENCHMARK_ARMS} arms are allowed`);
  }
  let total = 0;
  const names = new Set<string>();
  for (const spec of arms) {
    if (spec === null || typeof spec !== "object") throw new Error("benchmark execution: malformed arm");
    const arm = spec.arm;
    if (typeof arm !== "string" || arm.trim() === "" || /\s/.test(arm) || arm.includes("-") || arm.length > 64) {
      throw new Error(`benchmark execution: invalid arm name ${JSON.stringify(arm)} (no spaces or '-')`);
    }
    if (names.has(arm)) throw new Error(`benchmark execution: duplicate arm ${JSON.stringify(arm)}`);
    names.add(arm);
    if (!Array.isArray(spec.tasks) || spec.tasks.length > MAX_ROWS_PER_ARM) {
      throw new Error(`benchmark execution: arm ${JSON.stringify(arm)} has too many tasks (cap ${MAX_ROWS_PER_ARM})`);
    }
    for (const task of spec.tasks) {
      if (typeof task !== "string" || task.trim() === "") {
        throw new Error(`benchmark execution: arm ${JSON.stringify(arm)} has an empty task`);
      }
    }
    total += spec.tasks.length;
  }
  if (total > MAX_BENCHMARK_ROWS) {
    throw new Error(`benchmark execution: at most ${MAX_BENCHMARK_ROWS} rows are allowed`);
  }
}

/**
 * Merge the arm specs into the durable job file WITHOUT discarding prior
 * status, then delegate the actual per-row execution to `executeBatchJob`.
 * Existing rows keep their status (resume); same-id/different-task is a refusal
 * so a changed benchmark cannot silently reuse another run's terminal.
 */
function mergeArmRows(file: string, arms: readonly BenchmarkArmSpec[]): BatchJobRow[] {
  const existing = existsSync(file) ? loadBatchJob(file) : undefined;
  if (existing !== undefined && existing.corrupt.length > 0) {
    throw new Error(`benchmark execution: ${existing.corrupt.length} corrupt line(s) in ${file}`);
  }
  const byId = new Map<string, BatchJobRow>();
  for (const row of existing?.rows ?? []) byId.set(row.id, row);

  const fresh: BatchJobRow[] = [];
  for (const spec of arms) {
    spec.tasks.forEach((task, index) => {
      const id = `${spec.arm}-${index + 1}`;
      const prior = byId.get(id);
      if (prior !== undefined) {
        if (prior.task !== task) {
          throw new Error(`benchmark execution: row ${id} task changed since the last run — refusing to reuse its status`);
        }
        return; // keep prior status: structural resume
      }
      const row: BatchJobRow = { id, task, status: "pending" };
      byId.set(id, row);
      fresh.push(row);
    });
  }

  if (fresh.length > 0) {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "", "utf8");
    appendBatchJobRows(file, fresh);
  }
  return [...byId.values()];
}

/**
 * Execute the benchmark arms once through the shared batch engine and publish
 * typed metrics for the resulting rows. A second call with the same arms/file
 * is a resume: done/failed rows are skipped by `executeBatchJob`.
 */
export async function executeBenchmarkArms(opts: ExecuteBenchmarkArmsOptions): Promise<BenchmarkArmsResult> {
  if (typeof opts?.file !== "string" || opts.file.trim() === "") {
    throw new Error("benchmark execution: opts.file is required");
  }
  if (typeof opts.execute !== "function") {
    throw new Error("benchmark execution: opts.execute must be an injected guarded runtime");
  }
  validateArms(opts.arms);
  if (opts.arm !== undefined && opts.arm.trim() === "") {
    throw new Error("benchmark execution: --arm must be non-empty");
  }

  // Ruling 610: admit before mergeArmRows creates/appends the job JSONL.
  const { admitBatchJobWrite } = await import("./batch-runner");
  const refused = await admitBatchJobWrite(opts.file, path.dirname(path.resolve(opts.file)));
  if (refused !== undefined) throw new Error(refused);
  const allRows = mergeArmRows(opts.file, opts.arms);
  const selected = opts.arm !== undefined ? selectBatchRows(allRows, { arm: opts.arm }) : allRows;

  const summary = await executeBatchJob({
    file: opts.file,
    rows: selected,
    execute: opts.execute,
    ...(opts.spend !== undefined ? { spend: opts.spend } : {}),
    ...(opts.reserveUsd !== undefined ? { reserveUsd: opts.reserveUsd } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });

  const load = loadBatchJob(opts.file);
  if (load.corrupt.length > 0) {
    throw new Error(`benchmark execution: ${load.corrupt.length} corrupt line(s) after execution`);
  }
  const defs = opts.metricDefs ?? DEFAULT_BENCHMARK_METRICS;
  const metrics = defs.map((def) => computeBenchmarkMetric(def, load.rows));
  return {
    ...summary,
    rows: load.rows,
    metrics,
    arms: summarizeArms(load.rows),
    projection: inFlightProjection(load.rows),
    published: benchmarkManagerPublication(load.rows),
  };
}

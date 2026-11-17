/**
 * batch-run.ts — resumable JSONL batch runner (docs/30 J-2 / J-4 / I-5 reduced).
 *
 *   bun run batch --job <file.jsonl> [--filter text] [--arm prefix] [--shuffle [seed]]
 *                 [--slice start:end] [--write-config [path]] [--resume] [--config <path>]
 *                 [--dry-run] [--status] [--live] [--concurrency N]
 *
 * `--write-config` persists launch selection flags beside the job (or at an
 * explicit path). `--resume` recovers them so long runs need not re-specify
 * filter/arm/shuffle/slice (J-4 arm report via `--status`). Each pending row is
 * executed through the guarded runtime (I-5/J-2/J-4); Ctrl-C drains the
 * in-flight row before scheduling stops. One workspace-scoped `SpendLedger`
 * (C-5, honouring `HZ_SPEND_LIMIT_USD`) is shared by every row so the ceiling is
 * batch-wide. `--concurrency N` (default 1) bounds rows in flight (J-2).
 * Interactive Ctrl-C as input is a named residual.
 */

import {
  assertRunnerConfigMatchesJob,
  buildBatchRunnerConfig,
  defaultBatchRunnerConfigPath,
  formatBatchProgress,
  loadBatchJob,
  loadBatchRunnerConfig,
  pendingBatchRows,
  resolveBatchSelectionForResume,
  selectBatchRows,
  selectionFromRunnerConfig,
  writeBatchRunnerConfig,
  createBatchDrainController,
  executeBatchJob,
  normalizeBatchConcurrency,
  type BatchExecutionSummary,
  type BatchRowExecutor,
  type BatchSpendRail,
  type BatchSelectionOptions,
  type BatchJobRow,
} from "./core/batch-runner";
import { SpendLedger, spendLimitMicroFromEnv } from "./core/spend-ledger";
import type { EvalExecutor } from "./core/evals";
import { metricContract } from "./core/metrics";
import { formatBenchmarkManagerReport } from "./core/benchmark-manager";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface BatchCliIo {
  out(line: string): void;
  err(line: string): void;
}

const DEFAULT_IO: BatchCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE =
  "usage: bun run src/batch-run.ts --job <file.jsonl> [--filter text] [--arm prefix] [--shuffle [seed]] [--slice start:end] [--write-config [path]] [--resume] [--config <path>] [--dry-run] [--status] [--live] [--concurrency N]";

/** Default per-row spend reservation when a batch-wide ceiling is configured. */
export const DEFAULT_BATCH_RESERVE_USD = 0.01;

/** Injection seams for tests: a scripted guarded executor / abort signal / spend rail. */
export interface BatchCliOptions {
  executor?: BatchRowExecutor;
  signal?: AbortSignal;
  /** Explicit rail wins over the CLI-constructed workspace ledger (test seam). */
  spend?: BatchSpendRail;
  reserveUsd?: number;
  /** Workspace the batch-wide SpendLedger is scoped to (default process.cwd()). */
  workspace?: string;
  /** J-2: rows in flight (default 1); explicit option overrides `--concurrency`. */
  concurrency?: number;
  /** Env used to resolve `HZ_SPEND_LIMIT_USD` (default process.env). */
  spendEnv?: Record<string, string | undefined>;
  onDrain?: (message: string) => void;
}

/** Adapt the guarded eval-runtime executor to one batch row. No answer text is
 * copied back: the row records only the RC-7 terminal and a tool count. */
function guardedExecutorFrom(runtimeExecutor: EvalExecutor): BatchRowExecutor {
  return async (row: BatchJobRow) => {
    const result = await runtimeExecutor({
      id: row.id,
      from: `batch:${row.id}`,
      task: row.task,
      setup: { tools: [] },
      assertions: [
        { kind: "terminal", value: "succeeded" },
        { kind: "no_answer_leak" },
      ],
    });
    return {
      terminal: result.terminal,
      detail: `guarded run terminal=${result.terminal}, tools=${result.toolCalls?.length ?? 0}`,
    };
  };
}

/** Publish the execution summary through the metric contract (H-7). */
function batchExecutionPublished(s: BatchExecutionSummary): string[] {
  const population = `${s.total} selected row(s) in this batch run (bun run batch; executed through the injected guarded runtime)`;
  const anchor = "none — first batch execution measurement (no prior run of this set to compare against)";
  const excludes =
    "rows already done/failed before this run are skipped; a spend-limit refusal or Ctrl-C drain leaves the rest pending, not failed";
  return [
    metricContract({ metric: "batch rows executed", anchor, population, excludes, value: s.executed }),
    metricContract({ metric: "batch rows succeeded", anchor, population, excludes, value: s.done }),
    metricContract({ metric: "batch rows failed", anchor, population, excludes, value: s.failed }),
  ];
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

/** --slice is zero-based, half-open and applies to the full selected job list,
 * before completed rows are dropped by resume. */
function selectionFromArgs(argv: readonly string[]): { opts: BatchSelectionOptions; active: boolean } {
  const filter = argValue(argv, "--filter");
  if (filter !== undefined && filter.trim() === "") throw new Error("--filter requires a non-empty text value");
  const arm = argValue(argv, "--arm");
  if (arm !== undefined && arm.trim() === "") throw new Error("--arm requires a non-empty arm prefix");
  const sliceArg = argValue(argv, "--slice");
  let slice: BatchSelectionOptions["slice"];
  if (sliceArg !== undefined) {
    const match = /^(\d*):(\d*)$/.exec(sliceArg);
    if (!match) throw new Error("--slice requires start:end (zero-based, end exclusive)");
    const start = Number(match[1] || "0");
    const end = match[2] === "" ? undefined : Number(match[2]);
    if (!Number.isSafeInteger(start) || start < 0 ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
      throw new Error("--slice must use nonnegative safe integers with end >= start");
    }
    slice = { start, ...(end === undefined ? {} : { end }) };
  }
  const shuffleValue = argValue(argv, "--shuffle");
  const opts: BatchSelectionOptions = {
    ...(filter === undefined ? {} : { filter }),
    ...(arm === undefined ? {} : { arm }),
    ...(slice === undefined ? {} : { slice }),
    ...(shuffleValue === undefined ? {} : { shuffleSeed: shuffleValue || "0" }),
  };
  return {
    opts,
    active:
      filter !== undefined ||
      arm !== undefined ||
      slice !== undefined ||
      shuffleValue !== undefined,
  };
}

function configPathFromArgs(argv: readonly string[], job: string): { writePath?: string; resumePath?: string } {
  const writeFlag = argValue(argv, "--write-config");
  const writeRequested = argv.includes("--write-config");
  const explicitConfig = argValue(argv, "--config");
  if (explicitConfig !== undefined && explicitConfig.trim() === "") {
    throw new Error("--config requires a path");
  }
  const resume = argv.includes("--resume");
  if (resume && writeRequested) {
    throw new Error("--resume and --write-config cannot be combined");
  }
  const sidecar = defaultBatchRunnerConfigPath(job);
  return {
    ...(writeRequested
      ? { writePath: writeFlag && writeFlag.trim() !== "" ? path.resolve(writeFlag) : sidecar }
      : {}),
    ...(resume || explicitConfig !== undefined
      ? {
          resumePath:
            explicitConfig && explicitConfig.trim() !== ""
              ? path.resolve(explicitConfig)
              : sidecar,
        }
      : {}),
  };
}

export async function runBatchCli(argv: readonly string[], io: BatchCliIo = DEFAULT_IO, opts: BatchCliOptions = {}): Promise<number> {
  const job = argValue(argv, "--job");
  if (job === undefined || job === "") {
    io.err(USAGE);
    return 2;
  }
  const jobPath = path.resolve(job);

  let load;
  try {
    load = loadBatchJob(jobPath);
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (load.corrupt.length > 0) {
    io.err(`batch: ${load.corrupt.length} corrupt line(s) in ${jobPath} — refusing`);
    for (const row of load.corrupt) io.err(`  line ${row.line}: ${row.reason}`);
    return 2;
  }

  let cliSelection: { opts: BatchSelectionOptions; active: boolean };
  let paths: { writePath?: string; resumePath?: string };
  let cliConcurrency: number;
  try {
    cliSelection = selectionFromArgs(argv);
    paths = configPathFromArgs(argv, jobPath);
    cliConcurrency = normalizeBatchConcurrency(argValue(argv, "--concurrency"));
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const concurrency = normalizeBatchConcurrency(opts.concurrency ?? cliConcurrency);

  let selectedOpts = cliSelection.opts;
  let selectionActive = cliSelection.active;
  let resumedFrom: string | undefined;

  if (paths.resumePath !== undefined) {
    if (!existsSync(paths.resumePath)) {
      io.err(`batch: --resume/--config: missing runner-config at ${paths.resumePath}`);
      return 2;
    }
    try {
      const snap = loadBatchRunnerConfig(paths.resumePath);
      assertRunnerConfigMatchesJob(snap, jobPath);
      selectedOpts = resolveBatchSelectionForResume(selectionFromRunnerConfig(snap), cliSelection.opts);
      selectionActive =
        selectedOpts.filter !== undefined ||
        selectedOpts.arm !== undefined ||
        selectedOpts.shuffleSeed !== undefined ||
        selectedOpts.slice !== undefined;
      resumedFrom = paths.resumePath;
    } catch (err) {
      io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (paths.writePath !== undefined) {
    try {
      const config = buildBatchRunnerConfig(jobPath, cliSelection.opts);
      writeBatchRunnerConfig(paths.writePath, config);
      io.out(`batch runner-config: wrote ${paths.writePath}`);
    } catch (err) {
      io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  let selected;
  try {
    selected = selectBatchRows(load.rows, selectedOpts);
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (resumedFrom !== undefined) {
    io.out(`batch resume: loaded runner-config ${resumedFrom}`);
  }
  if (selectionActive) io.out(`batch selection: selected ${selected.length} of ${load.rows.length} rows`);

  const startedAt = Date.now();
  const progress = formatBatchProgress(selected, startedAt);
  if (progress !== undefined) io.out(progress);

  const pending = pendingBatchRows(selected);
  if (argv.includes("--status")) {
    io.out(`batch status: ${pending.length} pending of ${selected.length} total`);
    io.out(formatBenchmarkManagerReport(selected));
    return 0;
  }

  if (pending.length === 0) {
    io.out(selected.length === 0 && selectionActive
      ? "batch: selection matches no rows"
      : "batch: nothing pending (all rows done or failed)");
    return 0;
  }

  if (argv.includes("--dry-run")) {
    for (const row of pending) io.out(`would run: ${row.id} · ${summarizeTask(row)}`);
    io.out(`batch dry-run: ${pending.length} row(s) would execute through the guarded runtime`);
    return 0;
  }

  // Writing config alone is a successful no-op (its own slice).
  if (paths.writePath !== undefined && !argv.includes("--status") && !argv.includes("--dry-run")) {
    return 0;
  }

  // I-5/J-2/J-4: drive the pending rows through the guarded runtime. The
  // first SIGINT aborts SCHEDULING; the in-flight row is awaited to settle.
  const drain = createBatchDrainController(opts.onDrain ?? ((message) => io.out(message)));
  const signal = opts.signal ?? drain.signal;
  let executor = opts.executor;
  if (executor === undefined) {
    try {
      const { makeRuntimeExecutor } = await import("./core/eval-executor");
      const handle = makeRuntimeExecutor({ mock: !argv.includes("--live") });
      executor = guardedExecutorFrom(handle.executor);
    } catch (err) {
      drain.dispose();
      io.err(`batch: could not build the guarded runtime: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }
  // C-5: construct ONE workspace-scoped SpendLedger for the whole batch, so
  // every row draws from the same ceiling. `HZ_SPEND_LIMIT_USD` sets the limit;
  // 0/absent = unlimited (no rail constructed, so no per-row reservation). An
  // injected rail (tests) wins. The TTL reservation rail is wall-clock based and
  // lives inside SpendLedger, so the batch inherits it unchanged.
  const limitMicroUsd = spendLimitMicroFromEnv(opts.spendEnv ?? process.env);
  const spendRail: BatchSpendRail | undefined =
    opts.spend ??
    (limitMicroUsd > 0
      ? new SpendLedger(path.resolve(opts.workspace ?? process.cwd()), { limitMicroUsd })
      : undefined);
  const reserveUsd = opts.reserveUsd ?? DEFAULT_BATCH_RESERVE_USD;

  let summary: BatchExecutionSummary;
  try {
    summary = await executeBatchJob({
      file: jobPath,
      rows: selected,
      execute: executor!,
      ...(spendRail === undefined ? {} : { spend: spendRail, reserveUsd }),
      signal,
      concurrency,
      onEvent: (event) => {
        if (event.kind === "row.done" || event.kind === "row.failed") {
          const row = event.rows.find((r) => r.id === event.rowId);
          io.out(`batch row: ${event.rowId} · ${row?.status ?? "?"} · ${event.detail ?? ""}`);
          const progress = formatBatchProgress(event.rows, startedAt);
          if (progress !== undefined) io.out(progress);
        } else if (event.kind === "drain" || event.kind === "spend.limit") {
          io.out(`batch: ${event.detail ?? event.kind}`);
        }
      },
    });
  } catch (err) {
    io.err(`batch: execution failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    drain.dispose();
  }

  for (const block of batchExecutionPublished(summary)) io.out(block);
  io.out(
    `batch execution: ${summary.done} done / ${summary.failed} failed of ${summary.total} selected (${summary.skipped} skipped, ${summary.remaining} remaining${summary.drained ? ", drained" : ""})`,
  );
  return summary.failed === 0 ? 0 : 1;
}

function summarizeTask(row: BatchJobRow): string {
  const t = row.task.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

if (import.meta.main) {
  process.exitCode = await runBatchCli(process.argv.slice(2));
}

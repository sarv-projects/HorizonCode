/**
 * batch-run.ts — resumable JSONL batch job stub (docs/30 J-2 / J-4 reduced).
 *
 *   bun run batch --job <file.jsonl> [--filter text] [--arm prefix] [--shuffle [seed]]
 *                 [--slice start:end] [--write-config [path]] [--resume] [--config <path>]
 *                 [--dry-run] [--status]
 *
 * `--write-config` persists launch selection flags beside the job (or at an
 * explicit path). `--resume` recovers them so long runs need not re-specify
 * filter/arm/shuffle/slice (J-4 arm report via `--status`). Execution of each
 * row through the eval runner is not wired; Ctrl-C drain remains out of scope.
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
  type BatchSelectionOptions,
  type BatchJobRow,
} from "./core/batch-runner";
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
  "usage: bun run src/batch-run.ts --job <file.jsonl> [--filter text] [--arm prefix] [--shuffle [seed]] [--slice start:end] [--write-config [path]] [--resume] [--config <path>] [--dry-run] [--status]";

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

export async function runBatchCli(argv: readonly string[], io: BatchCliIo = DEFAULT_IO): Promise<number> {
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
  try {
    cliSelection = selectionFromArgs(argv);
    paths = configPathFromArgs(argv, jobPath);
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

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
    io.out(`batch dry-run: ${pending.length} row(s) would execute (runner wiring open)`);
    return 0;
  }

  // Writing config alone is a successful no-op for the execution stub.
  if (paths.writePath !== undefined && !argv.includes("--status") && !argv.includes("--dry-run")) {
    return 0;
  }

  io.err("batch: per-row execution is not wired — use `bun run eval` for cases or pass --dry-run");
  return 2;
}

function summarizeTask(row: BatchJobRow): string {
  const t = row.task.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

if (import.meta.main) {
  process.exitCode = await runBatchCli(process.argv.slice(2));
}

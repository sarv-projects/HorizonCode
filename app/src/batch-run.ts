/**
 * batch-run.ts — resumable JSONL batch job stub (docs/30 J-2 reduced).
 *
 *   bun run batch --job <file.jsonl> [--filter text] [--shuffle [seed]] [--slice start:end] [--dry-run] [--status]
 *
 * Execution of each row through the eval runner is not wired; this CLI loads,
 * resumes pending rows, and prints I-5 progress. Ctrl-C drain / interactive
 * steering are out of scope.
 */

import {
  formatBatchProgress,
  loadBatchJob,
  pendingBatchRows,
  selectBatchRows,
  type BatchSelectionOptions,
  type BatchJobRow,
} from "./core/batch-runner";
import { formatBenchmarkManagerReport } from "./core/benchmark-manager";

export interface BatchCliIo {
  out(line: string): void;
  err(line: string): void;
}

const DEFAULT_IO: BatchCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE = "usage: bun run src/batch-run.ts --job <file.jsonl> [--filter text] [--shuffle [seed]] [--slice start:end] [--dry-run] [--status]";

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
    ...(slice === undefined ? {} : { slice }),
    ...(shuffleValue === undefined ? {} : { shuffleSeed: shuffleValue || "0" }),
  };
  return { opts, active: filter !== undefined || slice !== undefined || shuffleValue !== undefined };
}

export async function runBatchCli(argv: readonly string[], io: BatchCliIo = DEFAULT_IO): Promise<number> {
  const job = argValue(argv, "--job");
  if (job === undefined || job === "") {
    io.err(USAGE);
    return 2;
  }

  let load;
  try {
    load = loadBatchJob(job);
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (load.corrupt.length > 0) {
    io.err(`batch: ${load.corrupt.length} corrupt line(s) in ${job} — refusing`);
    for (const row of load.corrupt) io.err(`  line ${row.line}: ${row.reason}`);
    return 2;
  }

  let selected = load.rows;
  let selectionActive = false;
  try {
    const selection = selectionFromArgs(argv);
    selected = selectBatchRows(load.rows, selection.opts);
    selectionActive = selection.active;
  } catch (err) {
    io.err(`batch: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
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

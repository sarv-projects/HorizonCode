/**
 * batch-run.ts — resumable JSONL batch job stub (docs/30 J-2 reduced).
 *
 *   bun run batch --job <file.jsonl> [--dry-run] [--status]
 *
 * Execution of each row through the eval runner is not wired; this CLI loads,
 * resumes pending rows, and prints I-5 progress. Ctrl-C drain / interactive
 * steering are out of scope.
 */

import {
  formatBatchProgress,
  loadBatchJob,
  pendingBatchRows,
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

const USAGE = "usage: bun run src/batch-run.ts --job <file.jsonl> [--dry-run] [--status]";

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
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

  const startedAt = Date.now();
  const progress = formatBatchProgress(load.rows, startedAt);
  if (progress !== undefined) io.out(progress);

  const pending = pendingBatchRows(load.rows);
  if (argv.includes("--status")) {
    io.out(`batch status: ${pending.length} pending of ${load.rows.length} total`);
    io.out(formatBenchmarkManagerReport(load.rows));
    return 0;
  }

  if (pending.length === 0) {
    io.out("batch: nothing pending (all rows done or failed)");
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

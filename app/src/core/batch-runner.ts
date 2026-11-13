/**
 * batch-runner.ts — resumable JSONL batch jobs (docs/30 J-2 reduced) and progress
 * text for batch ETA/histogram (docs/30 I-5 reduced).
 *
 * Each line is one job row. Resume skips rows whose status is `done` or `failed`.
 * `--shuffle` / `--slice` / runner-config snapshots are out of scope.
 */

import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export type BatchJobStatus = "pending" | "running" | "done" | "failed";

export interface BatchJobRow {
  id: string;
  task: string;
  status: BatchJobStatus;
  terminal?: string;
  detail?: string;
  updatedAt?: string;
}

export interface BatchJobLoad {
  path: string;
  rows: BatchJobRow[];
  corrupt: { line: number; reason: string }[];
}

const STATUS_ORDER: BatchJobStatus[] = ["pending", "running", "done", "failed"];

export function parseBatchJobLine(text: string, lineNo: number): BatchJobRow | { corrupt: { line: number; reason: string } } {
  const trimmed = text.trim();
  if (trimmed === "") return { corrupt: { line: lineNo, reason: "empty line" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { corrupt: { line: lineNo, reason: "invalid JSON" } };
  }
  const row = parsed as Partial<BatchJobRow>;
  if (typeof row.id !== "string" || row.id.trim() === "") {
    return { corrupt: { line: lineNo, reason: "missing id" } };
  }
  if (typeof row.task !== "string" || row.task.trim() === "") {
    return { corrupt: { line: lineNo, reason: "missing task" } };
  }
  const status = row.status ?? "pending";
  if (!STATUS_ORDER.includes(status)) return { corrupt: { line: lineNo, reason: `unknown status ${String(status)}` } };
  return {
    id: row.id.trim(),
    task: row.task,
    status,
    terminal: typeof row.terminal === "string" ? row.terminal : undefined,
    detail: typeof row.detail === "string" ? row.detail : undefined,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
  };
}

export function loadBatchJob(file: string): BatchJobLoad {
  const raw = readFileSync(file, "utf8");
  const rows: BatchJobRow[] = [];
  const corrupt: BatchJobLoad["corrupt"] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const parsed = parseBatchJobLine(line, i + 1);
    if ("corrupt" in parsed) corrupt.push(parsed.corrupt);
    else rows.push(parsed);
  }
  return { path: file, rows, corrupt };
}

/** Rows that still need execution (pending or a stale `running` from a crash). */
export function pendingBatchRows(rows: readonly BatchJobRow[]): BatchJobRow[] {
  return rows.filter((row) => row.status === "pending" || row.status === "running");
}

/** Persist one row update by rewriting the JSONL file atomically. */
export async function upsertBatchJobRow(file: string, id: string, patch: Partial<BatchJobRow>): Promise<void> {
  const load = loadBatchJob(file);
  const now = new Date().toISOString();
  let found = false;
  const next = load.rows.map((row) => {
    if (row.id !== id) return row;
    found = true;
    return { ...row, ...patch, id: row.id, task: row.task, updatedAt: now };
  });
  if (!found) throw new Error(`batch job: unknown id ${id}`);
  const text = `${next.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const dir = path.dirname(file);
  const tmpDir = mkdtempSync(path.join(dir, ".batch-"));
  const tmp = path.join(tmpDir, "job.jsonl");
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export interface BatchStatusHistogram {
  pending: number;
  running: number;
  done: number;
  failed: number;
  total: number;
}

export function batchStatusHistogram(rows: readonly BatchJobRow[]): BatchStatusHistogram {
  const hist: BatchStatusHistogram = { pending: 0, running: 0, done: 0, failed: 0, total: rows.length };
  for (const row of rows) hist[row.status] += 1;
  return hist;
}

/**
 * I-5 reduced: human progress line with per-status histogram and a coarse ETA.
 * Returns `undefined` when there is no batch (`rows.length === 0`).
 */
export function formatBatchProgress(rows: readonly BatchJobRow[], startedAtMs: number, nowMs = Date.now()): string | undefined {
  if (rows.length === 0) return undefined;
  const hist = batchStatusHistogram(rows);
  const finished = hist.done + hist.failed;
  const elapsedSec = Math.max(0.001, (nowMs - startedAtMs) / 1000);
  const rate = finished > 0 ? finished / elapsedSec : 0;
  const remaining = hist.pending + hist.running;
  const etaSec = rate > 0 ? remaining / rate : undefined;
  const eta =
    etaSec !== undefined && Number.isFinite(etaSec) ? ` · ETA ~${Math.ceil(etaSec)}s` : remaining === 0 ? "" : " · ETA unknown";
  return `batch: ${finished}/${hist.total} finished · pending=${hist.pending} running=${hist.running} done=${hist.done} failed=${hist.failed}${eta}`;
}

/** Append new rows (does not dedupe by id — caller's responsibility). */
export function appendBatchJobRows(file: string, rows: BatchJobRow[]): void {
  const chunk = rows.map((row) => JSON.stringify({ ...row, status: "pending" as const })).join("\n");
  appendFileSync(file, `${chunk}\n`, "utf8");
}

/** Read helper for tests (async wrapper). */
export async function readBatchJob(file: string): Promise<BatchJobLoad> {
  await readFile(file, "utf8");
  return loadBatchJob(file);
}

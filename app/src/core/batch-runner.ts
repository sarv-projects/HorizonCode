/**
 * batch-runner.ts — resumable JSONL batch jobs (docs/30 J-2 reduced) and progress
 * text for batch ETA/histogram/running cost (docs/30 I-5 reduced).
 *
 * Each line is one job row. Resume skips rows whose status is `done` or `failed`.
 * Deterministic --filter/--shuffle/--slice selection is available for planning.
 * A sidecar `*.runner-config.json` snapshots those launch flags (plus optional
 * J-4 `--arm`) so a later `--resume` need not re-specify them (omp metaharness
 * runner-config spirit). This module also drives the guarded per-row execution
 * engine (I-5/J-2/J-4): rows go through an injected guarded runtime, the existing
 * SpendLedger rail is reused for reserve-before-dispatch when a caller supplies
 * one, and Ctrl-C drains the in-flight row before scheduling stops.
 */

import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { canonicalJson, sha256Hex, type TerminalState, type Usage } from "../contracts";
import { HARNESS_PRICE_TABLE_REVISION, usageCostEventFields } from "./usage-cost";

export type BatchJobStatus = "pending" | "running" | "done" | "failed";

/**
 * Optional per-row usage for I-5 running cost. Prefer a recorded harness
 * `costMicroUsd` (H-2 / `hz.usage.recorded`); otherwise estimate from token
 * fields via `usage-cost.ts` when provider/model are present.
 */
export interface BatchJobUsage extends Usage {
  /** Integer micro-USD harness estimate when already known (ruling 455). */
  costMicroUsd?: number;
  provider?: string;
  model?: string;
}

export interface BatchJobRow {
  id: string;
  task: string;
  status: BatchJobStatus;
  terminal?: string;
  detail?: string;
  updatedAt?: string;
  /** When present, contributes to `formatBatchProgress` running harness cost. */
  usage?: BatchJobUsage;
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
  const usage = parseBatchJobUsage(row.usage);
  return {
    id: row.id.trim(),
    task: row.task,
    status,
    terminal: typeof row.terminal === "string" ? row.terminal : undefined,
    detail: typeof row.detail === "string" ? row.detail : undefined,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
    ...(usage === undefined ? {} : { usage }),
  };
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Soft-parse optional usage; malformed blobs are omitted (row still loads). */
export function parseBatchJobUsage(raw: unknown): BatchJobUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const usage: BatchJobUsage = {};
  const inputTokens = optionalFiniteNumber(src.inputTokens);
  const outputTokens = optionalFiniteNumber(src.outputTokens);
  const cacheCreationInputTokens = optionalFiniteNumber(src.cacheCreationInputTokens);
  const cacheReadInputTokens = optionalFiniteNumber(src.cacheReadInputTokens);
  const costMicroUsd = optionalFiniteNumber(src.costMicroUsd);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;
  if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
  if (costMicroUsd !== undefined) usage.costMicroUsd = Math.round(costMicroUsd);
  if (typeof src.provider === "string" && src.provider.trim() !== "") usage.provider = src.provider;
  if (typeof src.model === "string" && src.model.trim() !== "") usage.model = src.model;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * Harness micro-USD for one row: prefer recorded `costMicroUsd`, else H-2
 * `usageCostEventFields` from token fields + provider/model.
 */
export function batchRowCostMicroUsd(row: BatchJobRow): number | undefined {
  const usage = row.usage;
  if (!usage) return undefined;
  if (usage.costMicroUsd !== undefined && Number.isFinite(usage.costMicroUsd)) {
    return Math.round(usage.costMicroUsd);
  }
  const fields = usageCostEventFields(usage, usage.provider ?? "", usage.model ?? "");
  return fields?.costMicroUsd;
}

/** Sum harness micro-USD across rows that record usable usage; else undefined. */
export function batchRunningCostMicroUsd(rows: readonly BatchJobRow[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const cost = batchRowCostMicroUsd(row);
    if (cost === undefined) continue;
    any = true;
    sum += cost;
  }
  return any ? sum : undefined;
}

/** Progress-line fragment; undefined when no rows recorded usable usage. */
export function formatBatchRunningCost(rows: readonly BatchJobRow[]): string | undefined {
  const micro = batchRunningCostMicroUsd(rows);
  if (micro === undefined) return undefined;
  const usd = micro / 1_000_000;
  return ` · cost ~$${usd.toFixed(4)} (${HARNESS_PRICE_TABLE_REVISION})`;
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

export interface BatchSelectionOptions {
  /** Case-insensitive substring of the stable row id or task text. */
  filter?: string;
  /**
   * Exact job-id arm prefix (substring before the first `-`, or the whole id).
   * J-4 benchmark arms; snapshotted in runner-config with the other launch flags.
   */
  arm?: string;
  /** Stable content-independent ordering key; job status is NOT part of the hash. */
  shuffleSeed?: string;
  /** Zero-based, half-open range applied after filtering and shuffling. */
  slice?: { start: number; end?: number };
}

/** Arm = substring before the first `-` in the job id, or the whole id. */
export function armPrefixFromJobId(id: string): string {
  const trimmed = id.trim();
  const dash = trimmed.indexOf("-");
  return dash > 0 ? trimmed.slice(0, dash) : trimmed;
}

/**
 * Select a reproducible job subset without modifying rows or their status.
 * The full job population is selected BEFORE the pending/running resume filter,
 * so completed rows cannot shift positions in --slice on subsequent runs.
 * Order: filter → arm → shuffle → slice.
 */
export function selectBatchRows(
  rows: readonly BatchJobRow[],
  opts: BatchSelectionOptions = {},
): BatchJobRow[] {
  let selected = [...rows];
  if (opts.filter !== undefined) {
    const query = opts.filter.trim().toLowerCase();
    if (!query) throw new Error("batch selection: --filter must be non-empty");
    selected = selected.filter((row) =>
      row.id.toLowerCase().includes(query) || row.task.toLowerCase().includes(query));
  }
  if (opts.arm !== undefined) {
    const arm = opts.arm.trim();
    if (!arm) throw new Error("batch selection: --arm must be non-empty");
    selected = selected.filter((row) => armPrefixFromJobId(row.id) === arm);
  }
  if (opts.shuffleSeed !== undefined) {
    const seed = opts.shuffleSeed;
    const stableKey = (row: BatchJobRow): string =>
      createHash("sha256").update(seed).update("\0").update(row.id).digest("hex");
    selected = selected
      .map((row) => ({ row, key: stableKey(row) }))
      .sort((a, b) => a.key.localeCompare(b.key) ||
        a.row.id.localeCompare(b.row.id) || a.row.task.localeCompare(b.row.task))
      .map(({ row }) => row);
  }
  if (opts.slice) {
    const { start, end } = opts.slice;
    if (!Number.isSafeInteger(start) || start < 0 ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
      throw new Error("batch selection: --slice must be a valid nonnegative start:end range");
    }
    selected = selected.slice(start, end);
  }
  return selected;
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
 * I-5 reduced: human progress line with per-status histogram, coarse ETA, and
 * harness running cost when rows record usage (H-2 / usage-cost.ts).
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
  const cost = formatBatchRunningCost(rows) ?? "";
  return `batch: ${finished}/${hist.total} finished · pending=${hist.pending} running=${hist.running} done=${hist.done} failed=${hist.failed}${eta}${cost}`;
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

/**
 * Launch-flag snapshot for resumable batch runs (J-2 / omp runner-config.json).
 * Selection fields only — row status lives in the job JSONL, not here.
 */
export interface BatchRunnerConfigV1 {
  version: 1;
  /** Absolute job JSONL path recorded at write time. */
  job: string;
  filter?: string;
  /** Exact arm prefix (J-4); omitted when unset. */
  arm?: string;
  shuffleSeed?: string;
  slice?: { start: number; end?: number };
  writtenAt: string;
  /** sha256 of canonical {filter?, arm?, shuffleSeed?, slice?} (keys omitted when unset). */
  selectionHash: string;
}

/** Digest binding the selection subset of a runner-config (not the job path). */
export function batchSelectionHash(opts: BatchSelectionOptions): string {
  const body: Record<string, unknown> = {};
  if (opts.filter !== undefined) body.filter = opts.filter;
  if (opts.arm !== undefined) body.arm = opts.arm;
  if (opts.shuffleSeed !== undefined) body.shuffleSeed = opts.shuffleSeed;
  if (opts.slice !== undefined) {
    body.slice =
      opts.slice.end === undefined
        ? { start: opts.slice.start }
        : { start: opts.slice.start, end: opts.slice.end };
  }
  return sha256Hex(canonicalJson(body));
}

export function selectionFromRunnerConfig(config: BatchRunnerConfigV1): BatchSelectionOptions {
  return {
    ...(config.filter === undefined ? {} : { filter: config.filter }),
    ...(config.arm === undefined ? {} : { arm: config.arm }),
    ...(config.shuffleSeed === undefined ? {} : { shuffleSeed: config.shuffleSeed }),
    ...(config.slice === undefined ? {} : { slice: { ...config.slice } }),
  };
}

export function buildBatchRunnerConfig(
  jobFile: string,
  opts: BatchSelectionOptions = {},
  writtenAt = new Date().toISOString(),
): BatchRunnerConfigV1 {
  const job = path.resolve(jobFile);
  const clean: BatchSelectionOptions = {
    ...(opts.filter === undefined ? {} : { filter: opts.filter }),
    ...(opts.arm === undefined ? {} : { arm: opts.arm }),
    ...(opts.shuffleSeed === undefined ? {} : { shuffleSeed: opts.shuffleSeed }),
    ...(opts.slice === undefined
      ? {}
      : {
          slice:
            opts.slice.end === undefined
              ? { start: opts.slice.start }
              : { start: opts.slice.start, end: opts.slice.end },
        }),
  };
  return {
    version: 1,
    job,
    ...clean,
    writtenAt,
    selectionHash: batchSelectionHash(clean),
  };
}

/** Sidecar next to the job file: `job.jsonl` → `job.runner-config.json`. */
export function defaultBatchRunnerConfigPath(jobFile: string): string {
  const resolved = path.resolve(jobFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return path.join(dir, `${stem}.runner-config.json`);
}

export function writeBatchRunnerConfig(file: string, config: BatchRunnerConfigV1): void {
  const expected = batchSelectionHash(selectionFromRunnerConfig(config));
  if (config.version !== 1) throw new Error("batch runner-config: version must be 1");
  if (config.selectionHash !== expected) {
    throw new Error("batch runner-config: selectionHash does not match selection fields");
  }
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const dir = path.dirname(file);
  const tmpDir = mkdtempSync(path.join(dir, ".batch-cfg-"));
  const tmp = path.join(tmpDir, "runner-config.json");
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function loadBatchRunnerConfig(file: string): BatchRunnerConfigV1 {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`batch runner-config: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`batch runner-config: invalid JSON in ${file}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`batch runner-config: expected object in ${file}`);
  }
  const row = parsed as Partial<BatchRunnerConfigV1>;
  if (row.version !== 1) throw new Error(`batch runner-config: unsupported version ${String(row.version)}`);
  if (typeof row.job !== "string" || row.job.trim() === "") {
    throw new Error("batch runner-config: missing job path");
  }
  if (typeof row.writtenAt !== "string" || row.writtenAt.trim() === "") {
    throw new Error("batch runner-config: missing writtenAt");
  }
  if (typeof row.selectionHash !== "string" || !/^[0-9a-f]{64}$/.test(row.selectionHash)) {
    throw new Error("batch runner-config: missing or malformed selectionHash");
  }
  const opts: BatchSelectionOptions = {};
  if (row.filter !== undefined) {
    if (typeof row.filter !== "string" || row.filter.trim() === "") {
      throw new Error("batch runner-config: filter must be a non-empty string when set");
    }
    opts.filter = row.filter;
  }
  if (row.arm !== undefined) {
    if (typeof row.arm !== "string" || row.arm.trim() === "") {
      throw new Error("batch runner-config: arm must be a non-empty string when set");
    }
    opts.arm = row.arm;
  }
  if (row.shuffleSeed !== undefined) {
    if (typeof row.shuffleSeed !== "string") {
      throw new Error("batch runner-config: shuffleSeed must be a string when set");
    }
    opts.shuffleSeed = row.shuffleSeed;
  }
  if (row.slice !== undefined) {
    if (row.slice === null || typeof row.slice !== "object" || Array.isArray(row.slice)) {
      throw new Error("batch runner-config: slice must be an object when set");
    }
    const start = (row.slice as { start?: unknown }).start;
    const end = (row.slice as { end?: unknown }).end;
    if (!Number.isSafeInteger(start) || (start as number) < 0) {
      throw new Error("batch runner-config: slice.start must be a nonnegative safe integer");
    }
    if (end !== undefined && (!Number.isSafeInteger(end) || (end as number) < (start as number))) {
      throw new Error("batch runner-config: slice.end must be a safe integer >= start");
    }
    opts.slice = { start: start as number, ...(end === undefined ? {} : { end: end as number }) };
  }
  const expected = batchSelectionHash(opts);
  if (row.selectionHash !== expected) {
    throw new Error("batch runner-config: selectionHash does not match selection fields");
  }
  return {
    version: 1,
    job: path.resolve(row.job),
    ...opts,
    writtenAt: row.writtenAt,
    selectionHash: row.selectionHash,
  };
}

/** Refuse when the snapshot was recorded for a different job file. */
export function assertRunnerConfigMatchesJob(config: BatchRunnerConfigV1, jobFile: string): void {
  const expected = path.resolve(jobFile);
  if (path.resolve(config.job) !== expected) {
    throw new Error(
      `batch runner-config: job path mismatch (snapshot ${config.job} vs --job ${expected})`,
    );
  }
}

/**
 * On `--resume`, the snapshot is the source of truth. CLI selection flags are
 * optional restatements: when present they must hash-equal the snapshot.
 */
export function resolveBatchSelectionForResume(
  snapshot: BatchSelectionOptions,
  cli: BatchSelectionOptions,
): BatchSelectionOptions {
  const cliActive =
    cli.filter !== undefined ||
    cli.arm !== undefined ||
    cli.shuffleSeed !== undefined ||
    cli.slice !== undefined;
  if (!cliActive) return { ...snapshot };
  if (batchSelectionHash(cli) !== batchSelectionHash(snapshot)) {
    throw new Error("batch resume: CLI --filter/--arm/--shuffle/--slice disagrees with runner-config snapshot");
  }
  return { ...snapshot };
}

/* ------------------------- guarded row execution ------------------------ */

/**
 * The slice of SpendLedger the engine reuses (reserve before dispatch, settle
 * after). `SpendLedger` satisfies this structurally — no new budget knob and no
 * new runtime dependency. A caller whose guarded executor already reserves
 * its own spend (the CLI's `createRuntime` path) simply leaves `spend` unset,
 * so the same ceiling is not charged twice.
 */
export interface BatchSpendRail {
  reserve(usd: number, meta?: { note?: string; sessionId?: string; runId?: string }): { id: string };
  settle(id: string, usd: number, note?: string): unknown;
  release?(id: string): unknown;
}

/** The closed RC-7 terminal vocabulary a guarded row may report. */
const BATCH_TERMINALS: readonly string[] = [
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "unknown",
  "budget_exhausted",
  "timeout",
  "interrupted",
];

/** What one guarded row execution is allowed to report back to the engine. */
export interface BatchRowExecution {
  terminal: TerminalState;
  /** Short machine detail only — never the run's answer, code or a secret. */
  detail?: string;
  /** Optional usage for I-5 running-cost display. No answer text. */
  usage?: BatchJobUsage;
}

/** The injected guarded runtime: the CLI supplies a `createRuntime`-backed
 * executor; tests inject a small scripted one. Never constructed here. */
export type BatchRowExecutor = (row: BatchJobRow, signal?: AbortSignal) => Promise<BatchRowExecution>;

export type BatchExecutionEventKind =
  | "row.started"
  | "row.done"
  | "row.failed"
  | "spend.reserved"
  | "spend.limit"
  | "drain";

export interface BatchExecutionEvent {
  kind: BatchExecutionEventKind;
  rowId?: string;
  detail?: string;
  /** Row snapshot after the transition (for progress rendering). */
  rows: readonly BatchJobRow[];
}

export interface ExecuteBatchOptions {
  file: string;
  /** Pre-selected rows (e.g. after --filter/arm/shuffle/slice); defaults to all. */
  rows?: readonly BatchJobRow[];
  /** The guarded per-row runtime. Injected; the engine performs no I/O itself. */
  execute: BatchRowExecutor;
  /** Optional existing SpendLedger rail; reserve before dispatch, settle after. */
  spend?: BatchSpendRail;
  /** Positive USD to reserve per row when `spend` is set. */
  reserveUsd?: number;
  /** Ctrl-C drain: when aborted, no NEW row is scheduled; an in-flight row settles. */
  signal?: AbortSignal;
  onEvent?: (event: BatchExecutionEvent) => void;
}

export interface BatchExecutionSummary {
  total: number;
  executed: number;
  done: number;
  failed: number;
  /** Rows already done/failed before this run (resume skips them). */
  skipped: number;
  /** True when scheduling stopped early because of Ctrl-C or the spend ceiling. */
  drained: boolean;
  /** Rows still pending/running when the run returned. */
  remaining: number;
}

/** Cap and clean a row detail: a guard note, never answer text or a path. */
export function safeBatchRowDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean === "" ? undefined : clean.slice(0, 400);
}

/** Fail-closed validation of what a guarded executor reported. */
function normalizeBatchRowExecution(raw: unknown): BatchRowExecution {
  const result = raw as Partial<BatchRowExecution> | null;
  if (result === null || typeof result !== "object") {
    return { terminal: "failed", detail: "executor returned a non-object result — graded as failed" };
  }
  if (typeof result.terminal !== "string" || !BATCH_TERMINALS.includes(result.terminal)) {
    return {
      terminal: "failed",
      detail: `executor returned terminal ${JSON.stringify(result.terminal)} — not an RC-7 value; graded as failed`,
    };
  }
  const detail = safeBatchRowDetail(result.detail);
  const usage = parseBatchJobUsage(result.usage);
  return {
    terminal: result.terminal as TerminalState,
    ...(detail === undefined ? {} : { detail }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** USD actually attributable to one execution, from its reported usage. */
function batchExecutionCostUsd(
  row: BatchJobRow,
  execution: BatchRowExecution,
  fallbackUsd: number,
): number {
  if (execution.usage !== undefined) {
    const micro = batchRowCostMicroUsd({ ...row, usage: execution.usage });
    if (micro !== undefined && Number.isFinite(micro) && micro >= 0) return micro / 1_000_000;
  }
  return fallbackUsd;
}

function isSpendLimit(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "limit" || /HZ_SPEND_LIMIT|spend ceiling/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Execute the pending rows of a batch through the injected guarded runtime.
 *
 * Order per row: (1) honour Ctrl-C — stop scheduling when aborted, leaving the
 * rest pending; (2) reserve on the existing SpendLedger rail BEFORE dispatch;
 * (3) persist `running`; (4) await the guarded executor and validate its
 * terminal fail-closed; (5) settle spend with reported usage; (6) persist
 * `done`/`failed`. A throw from the executor is graded as a `failed` row, never
 * re-thrown — one bad row cannot abort the batch. Resume is structural:
 * `pendingBatchRows` runs pending rows and stale `running` rows; done/failed
 * rows are counted in `skipped` and never re-executed.
 */
export async function executeBatchJob(opts: ExecuteBatchOptions): Promise<BatchExecutionSummary> {
  if (typeof opts?.file !== "string" || opts.file.trim() === "") {
    throw new Error("executeBatchJob: opts.file is required");
  }
  if (typeof opts.execute !== "function") {
    throw new Error("executeBatchJob: opts.execute must be a function — the guarded runtime is injected");
  }
  if (opts.spend !== undefined) {
    if (typeof opts.spend.reserve !== "function" || typeof opts.spend.settle !== "function") {
      throw new Error("executeBatchJob: opts.spend must be a SpendLedger-like rail (reserve/settle)");
    }
    if (opts.reserveUsd === undefined || !Number.isFinite(opts.reserveUsd) || opts.reserveUsd <= 0) {
      throw new Error("executeBatchJob: opts.reserveUsd must be a positive finite number when opts.spend is set");
    }
  }

  const all = opts.rows ?? loadBatchJob(opts.file).rows;
  const todo = pendingBatchRows(all);
  const working: BatchJobRow[] = all.map((row) => ({ ...row }));
  const patchRow = (id: string, patch: Partial<BatchJobRow>): void => {
    const at = working.findIndex((row) => row.id === id);
    if (at >= 0) working[at] = { ...working[at]!, ...patch };
  };
  const emit = (event: Omit<BatchExecutionEvent, "rows">): void => {
    opts.onEvent?.({ ...event, rows: working.map((row) => ({ ...row })) });
  };

  let done = 0;
  let failed = 0;
  let drained = false;

  for (const row of todo) {
    if (opts.signal?.aborted === true) {
      drained = true;
      emit({ kind: "drain", detail: "Ctrl-C: stopping before the next row; the in-flight row was allowed to settle" });
      break;
    }

    let reservation: { id: string } | undefined;
    if (opts.spend !== undefined) {
      try {
        reservation = opts.spend.reserve(opts.reserveUsd!, { note: `batch row ${row.id}` });
        emit({ kind: "spend.reserved", rowId: row.id, detail: `reserved $${opts.reserveUsd!.toFixed(4)}` });
      } catch (err) {
        // Budget ceiling: the row is refused BEFORE dispatch and scheduling
        // stops — the same fail-closed posture the guarded runtime uses.
        const terminal: TerminalState = isSpendLimit(err) ? "budget_exhausted" : "failed";
        const detail = safeBatchRowDetail(`spend rail refused the row before dispatch: ${err instanceof Error ? err.message : String(err)}`);
        const patch: Partial<BatchJobRow> = { status: "failed", terminal, ...(detail === undefined ? {} : { detail }) };
        await upsertBatchJobRow(opts.file, row.id, patch);
        patchRow(row.id, patch);
        failed += 1;
        drained = true;
        emit({ kind: "spend.limit", rowId: row.id, detail });
        break;
      }
    }

    await upsertBatchJobRow(opts.file, row.id, { status: "running", detail: "executing" });
    patchRow(row.id, { status: "running", detail: "executing", terminal: undefined });
    emit({ kind: "row.started", rowId: row.id });

    let execution: BatchRowExecution;
    try {
      execution = normalizeBatchRowExecution(await opts.execute(row, opts.signal));
    } catch (err) {
      execution = {
        terminal: "failed",
        detail: `the guarded executor threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (opts.spend !== undefined && reservation !== undefined) {
      const actual = batchExecutionCostUsd(row, execution, opts.reserveUsd!);
      try {
        opts.spend.settle(reservation.id, actual, `batch row ${row.id}`);
      } catch {
        // Best-effort at this layer; the guarded runtime owns its own ledger.
      }
    }

    const status = execution.terminal === "succeeded" ? "done" : "failed";
    const patch: Partial<BatchJobRow> = {
      status,
      terminal: execution.terminal,
      ...(execution.detail === undefined ? {} : { detail: execution.detail }),
      ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    };
    await upsertBatchJobRow(opts.file, row.id, patch);
    patchRow(row.id, patch);
    if (status === "done") done += 1;
    else failed += 1;
    emit({ kind: status === "done" ? "row.done" : "row.failed", rowId: row.id, detail: execution.terminal });
  }

  return {
    total: all.length,
    executed: done + failed,
    done,
    failed,
    skipped: all.length - todo.length,
    drained,
    remaining: pendingBatchRows(working).length,
  };
}

/**
 * Ctrl-C drain controller. The first SIGINT (or an explicit `trigger()`, used
 * by tests) aborts scheduling; the in-flight guarded row is awaited to settle.
 * Interactive Ctrl-C-as-input inside a row is a named residual — this signal
 * governs the scheduler, not the text input of an interactive session.
 */
export interface BatchDrainController {
  signal: AbortSignal;
  trigger(): void;
  dispose(): void;
  readonly triggered: boolean;
}

export function createBatchDrainController(onDrain?: (message: string) => void): BatchDrainController {
  const controller = new AbortController();
  let triggered = false;
  const trigger = (): void => {
    if (triggered) return;
    triggered = true;
    controller.abort();
    onDrain?.(
      "batch: Ctrl-C received — draining the in-flight row, then stopping (interactive Ctrl-C as input remains a residual)",
    );
  };
  if (typeof process !== "undefined" && typeof process.on === "function") process.on("SIGINT", trigger);
  return {
    signal: controller.signal,
    trigger,
    dispose: () => {
      if (typeof process !== "undefined" && typeof process.off === "function") process.off("SIGINT", trigger);
    },
    get triggered() {
      return triggered;
    },
  };
}

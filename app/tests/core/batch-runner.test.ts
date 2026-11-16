import { describe, expect, test } from "bun:test";
import {
  assertRunnerConfigMatchesJob,
  batchRowCostMicroUsd,
  batchRunningCostMicroUsd,
  batchSelectionHash,
  buildBatchRunnerConfig,
  defaultBatchRunnerConfigPath,
  formatBatchProgress,
  formatBatchRunningCost,
  loadBatchJob,
  loadBatchRunnerConfig,
  pendingBatchRows,
  resolveBatchSelectionForResume,
  selectBatchRows,
  selectionFromRunnerConfig,
  upsertBatchJobRow,
  writeBatchRunnerConfig,
} from "../../src/core/batch-runner";
import { HARNESS_PRICE_TABLE_REVISION, usageCostEventFields } from "../../src/core/usage-cost";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("batch runner", () => {
  test("resume skips done rows", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-")), "job.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ id: "1", task: "a", status: "done" }),
        JSON.stringify({ id: "2", task: "b", status: "pending" }),
      ].join("\n") + "\n",
    );
    const load = loadBatchJob(file);
    expect(load.corrupt).toHaveLength(0);
    expect(pendingBatchRows(load.rows).map((r) => r.id)).toEqual(["2"]);
  });

  test("J-2 filter, stable shuffle and zero-based slice select rows before resume", () => {
    const rows = [
      { id: "a", task: "Build api", status: "done" as const },
      { id: "b", task: "Fix tests", status: "pending" as const },
      { id: "c", task: "Build UI", status: "pending" as const },
      { id: "d", task: "Build docs", status: "failed" as const },
    ];
    expect(selectBatchRows(rows, { filter: "BUILD", slice: { start: 1, end: 3 } }).map((r) => r.id)).toEqual(["c", "d"]);
    const one = selectBatchRows(rows, { shuffleSeed: "fixed" }).map((r) => r.id);
    const two = selectBatchRows([...rows].reverse(), { shuffleSeed: "fixed" }).map((r) => r.id);
    expect(one).toEqual(two);
    expect(pendingBatchRows(selectBatchRows(rows, { filter: "build" })).map((r) => r.id)).toEqual(["c"]);
  });

  test("J-2 refuses a reversed slice rather than returning a silent empty selection", () => {
    const rows = [{ id: "x", task: "task", status: "pending" as const }];
    expect(() => selectBatchRows(rows, { slice: { start: 2, end: 1 } })).toThrow(/slice/i);
  });

  test("formatBatchProgress is undefined for empty job", () => {
    expect(formatBatchProgress([], Date.now())).toBeUndefined();
  });

  test("I-5 running cost prefers recorded costMicroUsd and falls back to usage-cost", () => {
    const recorded = {
      id: "1",
      task: "a",
      status: "done" as const,
      usage: { costMicroUsd: 1_500 },
    };
    const estimated = {
      id: "2",
      task: "b",
      status: "done" as const,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        provider: "anthropic",
        model: "claude",
      },
    };
    const bare = { id: "3", task: "c", status: "pending" as const };
    expect(batchRowCostMicroUsd(recorded)).toBe(1_500);
    const expectedEst = usageCostEventFields(
      { inputTokens: 1_000_000, outputTokens: 0 },
      "anthropic",
      "claude",
    )!.costMicroUsd;
    expect(batchRowCostMicroUsd(estimated)).toBe(expectedEst);
    expect(batchRowCostMicroUsd(bare)).toBeUndefined();
    expect(batchRunningCostMicroUsd([recorded, estimated, bare])).toBe(1_500 + expectedEst);
    expect(formatBatchRunningCost([bare])).toBeUndefined();
    expect(formatBatchRunningCost([recorded])).toBe(
      ` · cost ~$0.0015 (${HARNESS_PRICE_TABLE_REVISION})`,
    );
    const now = 10_000;
    const line = formatBatchProgress([recorded, estimated, bare], now - 5_000, now);
    expect(line).toContain("pending=1");
    expect(line).toContain("done=2");
    expect(line).toContain(`cost ~$${((1_500 + expectedEst) / 1_000_000).toFixed(4)}`);
    expect(line).toContain(HARNESS_PRICE_TABLE_REVISION);
  });

  test("I-5 running cost loads from JSONL usage and omits when absent", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cost-")), "job.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          id: "1",
          task: "a",
          status: "done",
          usage: { costMicroUsd: 2_000_000 },
        }),
        JSON.stringify({ id: "2", task: "b", status: "pending", usage: "bad" }),
        JSON.stringify({ id: "3", task: "c", status: "pending" }),
      ].join("\n") + "\n",
    );
    const load = loadBatchJob(file);
    expect(load.corrupt).toHaveLength(0);
    expect(load.rows[0]?.usage?.costMicroUsd).toBe(2_000_000);
    expect(load.rows[1]?.usage).toBeUndefined();
    const line = formatBatchProgress(load.rows, Date.now());
    expect(line).toContain(`cost ~$2.0000 (${HARNESS_PRICE_TABLE_REVISION})`);
    expect(formatBatchProgress([{ id: "x", task: "t", status: "pending" }], Date.now())).not.toContain(
      "cost ~$",
    );
  });

  test("upsertBatchJobRow updates status", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-")), "job.jsonl");
    writeFileSync(file, `${JSON.stringify({ id: "x", task: "t", status: "pending" })}\n`);
    await upsertBatchJobRow(file, "x", { status: "done", terminal: "succeeded" });
    const load = loadBatchJob(file);
    expect(load.rows[0]?.status).toBe("done");
    expect(pendingBatchRows(load.rows)).toHaveLength(0);
  });

  test("J-2 runner-config snapshot round-trips selection and refuses hash drift", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "batch-cfg-"));
    const job = path.join(dir, "job.jsonl");
    writeFileSync(job, `${JSON.stringify({ id: "a", task: "t", status: "pending" })}\n`);
    const opts = { filter: "BUILD", shuffleSeed: "fixed", slice: { start: 1, end: 3 } };
    const cfgPath = defaultBatchRunnerConfigPath(job);
    expect(cfgPath).toBe(path.join(dir, "job.runner-config.json"));
    const built = buildBatchRunnerConfig(job, opts, "2026-11-15T00:00:00.000Z");
    expect(built.selectionHash).toBe(batchSelectionHash(opts));
    writeBatchRunnerConfig(cfgPath, built);
    const loaded = loadBatchRunnerConfig(cfgPath);
    expect(selectionFromRunnerConfig(loaded)).toEqual(opts);
    assertRunnerConfigMatchesJob(loaded, job);
    expect(resolveBatchSelectionForResume(selectionFromRunnerConfig(loaded), {})).toEqual(opts);
    expect(resolveBatchSelectionForResume(selectionFromRunnerConfig(loaded), opts)).toEqual(opts);
    expect(() => resolveBatchSelectionForResume(opts, { filter: "other" })).toThrow(/disagrees/i);
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as { selectionHash: string; filter: string };
    raw.filter = "tampered";
    writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(() => loadBatchRunnerConfig(cfgPath)).toThrow(/selectionHash/i);
  });

  test("J-4 arm selection is snapshotted in runner-config and applied before slice", () => {
    const rows = [
      { id: "eval-1", task: "a", status: "done" as const },
      { id: "eval-2", task: "b", status: "pending" as const },
      { id: "lint-1", task: "c", status: "pending" as const },
    ];
    expect(selectBatchRows(rows, { arm: "eval" }).map((r) => r.id)).toEqual(["eval-1", "eval-2"]);
    expect(selectBatchRows(rows, { arm: "eval", slice: { start: 1 } }).map((r) => r.id)).toEqual([
      "eval-2",
    ]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "batch-arm-cfg-"));
    const job = path.join(dir, "job.jsonl");
    writeFileSync(job, `${JSON.stringify(rows[0])}\n`);
    const opts = { arm: "eval", filter: "eval" };
    const built = buildBatchRunnerConfig(job, opts);
    expect(built.arm).toBe("eval");
    expect(built.selectionHash).toBe(batchSelectionHash(opts));
    const cfgPath = defaultBatchRunnerConfigPath(job);
    writeBatchRunnerConfig(cfgPath, built);
    expect(selectionFromRunnerConfig(loadBatchRunnerConfig(cfgPath))).toEqual(opts);
  });

  test("J-2 runner-config refuses a job path mismatch", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "batch-cfg-job-"));
    const job = path.join(dir, "job.jsonl");
    const other = path.join(dir, "other.jsonl");
    writeFileSync(job, `${JSON.stringify({ id: "a", task: "t", status: "pending" })}\n`);
    const built = buildBatchRunnerConfig(job, { filter: "x" });
    expect(() => assertRunnerConfigMatchesJob(built, other)).toThrow(/job path mismatch/i);
  });
});

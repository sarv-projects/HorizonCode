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
  createBatchDrainController,
  executeBatchJob,
  normalizeBatchConcurrency,
  MAX_BATCH_CONCURRENCY,
  safeBatchRowDetail,
  resolveBatchSelectionForResume,
  selectBatchRows,
  selectionFromRunnerConfig,
  upsertBatchJobRow,
  writeBatchRunnerConfig,
} from "../../src/core/batch-runner";
import { HARNESS_PRICE_TABLE_REVISION, usageCostEventFields } from "../../src/core/usage-cost";
import { SpendLedger } from "../../src/core/spend-ledger";
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


/** helper: a fresh job file with the given rows. */
function batchFile(rows: Record<string, unknown>[]): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-exec-")), "job.jsonl");
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

describe("batch guarded execution engine (I-5/J-2/J-4)", () => {
  test("executes a small scripted batch and persists every row transition", async () => {
    const file = batchFile([
      { id: "a", task: "ok one", status: "pending" },
      { id: "b", task: "fail two", status: "pending" },
      { id: "c", task: "ok three", status: "pending" },
    ]);
    const seen: string[] = [];
    const result = await executeBatchJob({
      file,
      execute: async (row) => {
        seen.push(row.id);
        return row.task.includes("fail")
          ? { terminal: "failed", detail: "scripted failure" }
          : { terminal: "succeeded", usage: { costMicroUsd: 100, provider: "mock", model: "m" } };
      },
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ total: 3, executed: 3, done: 2, failed: 1, skipped: 0, drained: false, remaining: 0 });
    const rows = loadBatchJob(file).rows;
    expect(rows.map((r) => [r.id, r.status, r.terminal])).toEqual([
      ["a", "done", "succeeded"],
      ["b", "failed", "failed"],
      ["c", "done", "succeeded"],
    ]);
    expect(rows[0]?.usage?.costMicroUsd).toBe(100);
    expect(rows[1]?.detail).toContain("scripted failure");
  });

  test("resume skips done/failed rows and runs pending + stale running", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "done", terminal: "succeeded" },
      { id: "b", task: "b", status: "failed", terminal: "failed" },
      { id: "c", task: "c", status: "running" },
      { id: "d", task: "d", status: "pending" },
    ]);
    const ran: string[] = [];
    const result = await executeBatchJob({
      file,
      execute: async (row) => (ran.push(row.id), { terminal: "succeeded" as const }),
    });
    expect(ran).toEqual(["c", "d"]);
    expect(result).toMatchObject({ skipped: 2, executed: 2, done: 2, failed: 0, remaining: 0 });
  });

  test("Ctrl-C drain settles the in-flight row then stops scheduling", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
    ]);
    const controller = new AbortController();
    const drainEvents: string[] = [];
    const seen: string[] = [];
    const result = await executeBatchJob({
      file,
      signal: controller.signal,
      onEvent: (e) => { if (e.kind === "drain") drainEvents.push(e.detail ?? "drain"); },
      execute: async (row) => {
        seen.push(row.id);
        if (row.id === "a") controller.abort(); // simulate SIGINT mid-flight
        await new Promise((r) => setTimeout(r, 2)); // in-flight work continues
        return { terminal: "succeeded" };
      },
    });
    expect(seen).toEqual(["a"]);
    expect(result).toMatchObject({ done: 1, failed: 0, drained: true, remaining: 2 });
    const rows = loadBatchJob(file).rows;
    expect(rows[0]?.status).toBe("done");
    expect(rows.slice(1).map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(drainEvents[0]).toContain("in-flight row was allowed to settle");
  });

  test("drain controller is idempotent and disposes its SIGINT listener", () => {
    const msgs: string[] = [];
    const drain = createBatchDrainController((m) => msgs.push(m));
    expect(drain.triggered).toBe(false);
    drain.trigger();
    drain.trigger();
    expect(drain.triggered).toBe(true);
    expect(drain.signal.aborted).toBe(true);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("residual");
    drain.dispose();
  });

  test("reuses SpendLedger: reserve before dispatch, settle after, refuse at ceiling", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "batch-spend-"));
    const file = path.join(dir, "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    // One micro-USD ceiling: row a reserves+settles it; row b is refused before
    // dispatch; row c is never scheduled. No new budget knob — the existing
    // SpendLedger limit override is the only ceiling.
    const spend = new SpendLedger(dir, { limitMicroUsd: 1 });
    const seen: string[] = [];
    const result = await executeBatchJob({
      file,
      spend,
      reserveUsd: 0.000001,
      execute: async (row) => (seen.push(row.id), { terminal: "succeeded" as const }),
    });
    expect(seen).toEqual(["a"]);
    expect(result).toMatchObject({ done: 1, failed: 1, drained: true, remaining: 1 });
    const rows = loadBatchJob(file).rows;
    expect(rows[0]?.status).toBe("done");
    expect(rows[1]?.status).toBe("failed");
    expect(rows[1]?.terminal).toBe("budget_exhausted");
    expect(rows[2]?.status).toBe("pending");
    expect(spend.status().spentUsd).toBeCloseTo(0.000001, 9);
  });

  test("fail-closed grading: a throw or malformed terminal becomes a failed row, batch continues", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
    ]);
    let call = 0;
    const result = await executeBatchJob({
      file,
      execute: async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
        if (call === 2) return { terminal: "yolo" } as never;
        return { terminal: "succeeded" };
      },
    });
    expect(result).toMatchObject({ done: 1, failed: 2, remaining: 0 });
    const rows = loadBatchJob(file).rows;
    expect(rows[0]?.detail).toContain("boom");
    expect(rows[1]?.detail).toContain("not an RC-7 value");
    expect(safeBatchRowDetail("  ok\u0000bad  ")).toBe("ok bad");
  });
});

describe("batch worker pool (J-2 concurrency)", () => {
  test("concurrency 2 overlaps rows while persisting every terminal", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
      { id: "d", task: "d", status: "pending" },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const ran: string[] = [];
    const result = await executeBatchJob({
      file,
      concurrency: 2,
      execute: async (row) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        ran.push(row.id);
        await new Promise((r) => setTimeout(r, 8));
        inFlight -= 1;
        return { terminal: "succeeded" };
      },
    });
    expect(maxInFlight).toBe(2);
    expect(ran.slice().sort()).toEqual(["a", "b", "c", "d"]);
    expect(result).toMatchObject({ done: 4, failed: 0, remaining: 0 });
    const rows = loadBatchJob(file).rows;
    expect(rows.every((r) => r.status === "done" && r.terminal === "succeeded")).toBe(true);
  });

  test("a failed terminal in one worker does not kill unrelated rows", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
      { id: "d", task: "d", status: "pending" },
    ]);
    const result = await executeBatchJob({
      file,
      concurrency: 2,
      execute: async (row) =>
        row.id === "b"
          ? { terminal: "failed", detail: "scripted failure" }
          : row.id === "c"
            ? ({ terminal: "yolo" } as never)
            : { terminal: "succeeded" },
    });
    expect(result).toMatchObject({ done: 2, failed: 2, remaining: 0 });
    const rows = loadBatchJob(file).rows;
    expect(rows.map((r) => r.status)).toEqual(["done", "failed", "failed", "done"]);
    expect(rows[1]?.detail).toContain("scripted failure");
    expect(rows[2]?.detail).toContain("not an RC-7 value");
  });

  test("resume with concurrency only runs pending/stale, skipping done/failed", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "done", terminal: "succeeded" },
      { id: "b", task: "b", status: "failed", terminal: "failed" },
      { id: "c", task: "c", status: "running" },
      { id: "d", task: "d", status: "pending" },
    ]);
    const ran: string[] = [];
    const result = await executeBatchJob({
      file,
      concurrency: 3,
      execute: async (row) => (ran.push(row.id), { terminal: "succeeded" as const }),
    });
    expect(ran.slice().sort()).toEqual(["c", "d"]);
    expect(result).toMatchObject({ skipped: 2, executed: 2, done: 2, failed: 0, remaining: 0 });
  });

  test("drain stops new claims and awaits all in-flight rows to a fail-closed terminal", async () => {
    const file = batchFile([
      { id: "a", task: "a", status: "pending" },
      { id: "b", task: "b", status: "pending" },
      { id: "c", task: "c", status: "pending" },
      { id: "d", task: "d", status: "pending" },
    ]);
    const controller = new AbortController();
    let resolveRelease!: () => void;
    const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
    const ran: string[] = [];
    const running = executeBatchJob({
      file,
      concurrency: 2,
      signal: controller.signal,
      execute: async (row) => {
        ran.push(row.id);
        await release; // hold the two in-flight rows until released
        return { terminal: "succeeded" };
      },
    });
    // Let a and b get dispatched and held in flight.
    await new Promise((r) => setTimeout(r, 12));
    expect(ran.slice().sort()).toEqual(["a", "b"]);
    controller.abort(); // stop claiming c/d while a,b are in flight
    resolveRelease(); // let the in-flight rows settle
    const result = await running;
    expect(result).toMatchObject({ done: 2, failed: 0, drained: true, remaining: 2 });
    const rows = loadBatchJob(file).rows;
    expect(rows.slice(0, 2).map((r) => r.status)).toEqual(["done", "done"]);
    expect(rows.slice(2).map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  test("concurrency validation rejects 0, negatives, non-integers and values above the cap", () => {
    expect(normalizeBatchConcurrency(undefined)).toBe(1);
    expect(normalizeBatchConcurrency("4")).toBe(4);
    expect(normalizeBatchConcurrency(2)).toBe(2);
    for (const bad of [0, -1, 1.5, "oops", MAX_BATCH_CONCURRENCY + 1]) {
      expect(() => normalizeBatchConcurrency(bad)).toThrow(/--concurrency/i);
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  formatBatchProgress,
  loadBatchJob,
  pendingBatchRows,
  selectBatchRows,
  upsertBatchJobRow,
} from "../../src/core/batch-runner";
import { mkdtempSync, writeFileSync } from "node:fs";
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

  test("upsertBatchJobRow updates status", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-")), "job.jsonl");
    writeFileSync(file, `${JSON.stringify({ id: "x", task: "t", status: "pending" })}\n`);
    await upsertBatchJobRow(file, "x", { status: "done", terminal: "succeeded" });
    const load = loadBatchJob(file);
    expect(load.rows[0]?.status).toBe("done");
    expect(pendingBatchRows(load.rows)).toHaveLength(0);
  });
});

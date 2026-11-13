import { describe, expect, test } from "bun:test";
import {
  formatBatchProgress,
  loadBatchJob,
  pendingBatchRows,
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

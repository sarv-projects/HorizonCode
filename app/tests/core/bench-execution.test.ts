/** J-4 bench-execution.test.ts — shared per-row engine reuse, typed metrics, resume. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { executeBenchmarkArms, type BenchmarkArmSpec } from "../../src/core/bench-execution";
import type { BatchRowExecutor } from "../../src/core/batch-runner";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const arms: BenchmarkArmSpec[] = [
  { arm: "alpha", tasks: ["task a1", "task a2"] },
  { arm: "beta", tasks: ["task b1"] },
];

function recordingExecutor(seen: string[], failFirst = false): BatchRowExecutor {
  return async (row) => {
    seen.push(row.id);
    if (failFirst && seen.length === 1) return { terminal: "failed", detail: "scripted failure" };
    return { terminal: "succeeded" };
  };
}

describe("J-4 benchmark arm execution engine reuse", () => {
  test("two arms execute through the injected guarded runtime with typed metrics", async () => {
    const file = path.join(tempDir("hz-bench-exec-"), "job.jsonl");
    const seen: string[] = [];
    const result = await executeBenchmarkArms({ file, arms, execute: recordingExecutor(seen) });
    expect(seen.sort()).toEqual(["alpha-1", "alpha-2", "beta-1"]);
    expect(result.executed).toBe(3);
    expect(result.done).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.rows.every((r) => r.status === "done")).toBe(true);
    expect(result.metrics.map((m) => m.key).sort()).toEqual(["fail_rate", "pass_rate", "pending"]);
    const pass = result.metrics.find((m) => m.key === "pass_rate")!;
    expect(pass.value).toBe(1);
    expect(pass.formatted).toBe("1.0000");
    expect(pass.higherIsBetter).toBe(true);
    expect(result.arms.map((a) => a.arm)).toEqual(["alpha", "beta"]);
    expect(result.projection.basis).toBe("observed");
    expect(result.published.join("\n")).toContain("benchmark projected pass rate");
  });

  test("resume skips done rows (second call executes nothing)", async () => {
    const dir = tempDir("hz-bench-resume-");
    const file = path.join(dir, "job.jsonl");
    const first: string[] = [];
    await executeBenchmarkArms({ file, arms, execute: recordingExecutor(first) });
    expect(first.length).toBe(3);
    const second: string[] = [];
    const resumed = await executeBenchmarkArms({ file, arms, execute: recordingExecutor(second) });
    expect(second).toEqual([]);
    expect(resumed.executed).toBe(0);
    expect(resumed.skipped).toBe(3);
    // `done`/`failed` count THIS run's executions; the durable rows are the
    // cumulative resume source (batch-runner semantics, reused unchanged).
    expect(resumed.done).toBe(0);
    expect(resumed.rows.every((r) => r.status === "done")).toBe(true);
  });

  test("a failed row is terminal on resume (skipped, not silently re-run)", async () => {
    const dir = tempDir("hz-bench-partial-");
    const file = path.join(dir, "job.jsonl");
    const first = await executeBenchmarkArms({ file, arms, execute: recordingExecutor([], true) });
    expect(first.done).toBe(2);
    expect(first.failed).toBe(1);
    const failRate = first.metrics.find((m) => m.key === "fail_rate")!;
    expect(failRate.value).toBeCloseTo(1 / 3, 9);
    const retried: string[] = [];
    const second = await executeBenchmarkArms({ file, arms, execute: recordingExecutor(retried) });
    expect(retried).toEqual([]);
    expect(second.skipped).toBe(3);
    expect(second.done).toBe(0);
    expect(second.rows.filter((r) => r.status === "failed").length).toBe(1);
    expect(second.metrics.find((m) => m.key === "fail_rate")!.value).toBeCloseTo(1 / 3, 9);
  });

  test("existing done rows are preserved when new arms/tasks are added", async () => {
    const dir = tempDir("hz-bench-append-");
    const file = path.join(dir, "job.jsonl");
    writeFileSync(file, `${JSON.stringify({ id: "alpha-1", task: "task a1", status: "done", terminal: "succeeded" })}\n`, "utf8");
    const seen: string[] = [];
    const result = await executeBenchmarkArms({ file, arms, execute: recordingExecutor(seen) });
    expect(seen.sort()).toEqual(["alpha-2", "beta-1"]);
    expect(result.skipped).toBe(1);
    expect(result.done).toBe(2);
    expect(result.rows.every((r) => r.status === "done")).toBe(true);
  });

  test("bounds and drift refusal fail closed", async () => {
    const file = path.join(tempDir("hz-bench-bounds-"), "job.jsonl");
    await expect(executeBenchmarkArms({ file, arms: [], execute: recordingExecutor([]) })).rejects.toThrow(/at least one arm/);
    await expect(executeBenchmarkArms({ file, arms: [{ arm: "bad-arm", tasks: ["t"] }], execute: recordingExecutor([]) })).rejects.toThrow(/invalid arm name/);
    const dir = tempDir("hz-bench-drift-");
    const driftFile = path.join(dir, "job.jsonl");
    writeFileSync(driftFile, `${JSON.stringify({ id: "alpha-1", task: "different", status: "done" })}\n`, "utf8");
    await expect(executeBenchmarkArms({ file: driftFile, arms, execute: recordingExecutor([]) })).rejects.toThrow(/task changed/);
  });

  test("admitBatchJobWrite refuses deny before arm merge (ruling 610)", async () => {
    const dir = tempDir("hz-bench-deny-");
    const file = path.join(dir, "job.jsonl");
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(dir, "no-such-hz-kernel");
    try {
      const kernelState = path.join(dir, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-bench" }]),
        "utf8",
      );
      await expect(executeBenchmarkArms({ file, arms, execute: recordingExecutor([]) })).rejects.toThrow(
        /denied|test-deny-bench|batch-job/i,
      );
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);
});

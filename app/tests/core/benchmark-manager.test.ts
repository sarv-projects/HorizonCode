import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  armPrefixFromJobId,
  formatBenchmarkManagerReport,
  resumeBenchmarkFromRunnerConfig,
  summarizeArms,
} from "../../src/core/benchmark-manager";
import {
  buildBatchRunnerConfig,
  defaultBatchRunnerConfigPath,
  writeBatchRunnerConfig,
  type BatchJobRow,
} from "../../src/core/batch-runner";

describe("J-4 benchmark manager", () => {
  const rows: BatchJobRow[] = [
    { id: "eval-1", task: "a", status: "done" },
    { id: "eval-2", task: "b", status: "failed" },
    { id: "lint-1", task: "c", status: "pending" },
  ];

  test("arm prefix grouping", () => {
    expect(armPrefixFromJobId("eval-9")).toBe("eval");
    const arms = summarizeArms(rows);
    expect(arms.map((a) => a.arm).sort()).toEqual(["eval", "lint"]);
    expect(arms.find((a) => a.arm === "eval")?.done).toBe(1);
    expect(arms.find((a) => a.arm === "eval")?.projectedPassRate).toBe(0.5);
  });

  test("report is byte-stable", () => {
    const text = formatBenchmarkManagerReport(rows);
    expect(text).toContain("pass_rate");
    expect(text).toContain("eval:");
  });

  test("J-4 resumeBenchmarkFromRunnerConfig recovers --arm without re-spec", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bench-resume-"));
    const job = path.join(dir, "job.jsonl");
    writeFileSync(
      job,
      [
        { id: "eval-1", task: "a", status: "done" },
        { id: "eval-2", task: "b", status: "pending" },
        { id: "lint-1", task: "c", status: "pending" },
        { id: "lint-2", task: "d", status: "failed" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const cfgPath = defaultBatchRunnerConfigPath(job);
    writeBatchRunnerConfig(cfgPath, buildBatchRunnerConfig(job, { arm: "eval" }));

    const resumed = resumeBenchmarkFromRunnerConfig({ jobPath: job, configPath: cfgPath });
    expect(resumed.selection.arm).toBe("eval");
    expect(resumed.rows.map((r) => r.id)).toEqual(["eval-1", "eval-2"]);
    expect(resumed.arms).toHaveLength(1);
    expect(resumed.arms[0]?.arm).toBe("eval");
    expect(resumed.report).toContain("eval:");
    expect(resumed.report).not.toContain("lint:");
  });

  test("J-4 resume refuses CLI arm that disagrees with runner-config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bench-disagree-"));
    const job = path.join(dir, "job.jsonl");
    writeFileSync(job, `${JSON.stringify({ id: "eval-1", task: "a", status: "pending" })}\n`);
    const cfgPath = defaultBatchRunnerConfigPath(job);
    writeBatchRunnerConfig(cfgPath, buildBatchRunnerConfig(job, { arm: "eval" }));
    expect(() =>
      resumeBenchmarkFromRunnerConfig({
        jobPath: job,
        configPath: cfgPath,
        cli: { arm: "lint" },
      }),
    ).toThrow(/disagrees/i);
  });
});

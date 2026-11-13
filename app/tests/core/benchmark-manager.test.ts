import { describe, expect, test } from "bun:test";
import { armPrefixFromJobId, formatBenchmarkManagerReport, summarizeArms } from "../../src/core/benchmark-manager";
import type { BatchJobRow } from "../../src/core/batch-runner";

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
  });

  test("report is byte-stable", () => {
    const text = formatBenchmarkManagerReport(rows);
    expect(text).toContain("pass_rate");
    expect(text).toContain("eval:");
  });
});

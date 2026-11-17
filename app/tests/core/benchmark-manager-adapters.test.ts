/** benchmark-manager-adapters.test.ts — J-4 typed omp adapters + in-flight projections. */

import { describe, expect, test } from "bun:test";
import type { BatchJobRow } from "../../src/core/batch-runner";
import {
  computeBenchmarkMetric,
  computeDefaultBenchmarkMetrics,
  inFlightProjection,
  isOmpMetricKey,
  OMP_METRIC_ADAPTERS,
  type BenchmarkMetricDef,
} from "../../src/core/benchmark-manager";

function rows(statuses: BatchJobRow["status"][]): BatchJobRow[] {
  return statuses.map((status, i) => ({ id: `arm-${i}`, task: "t", status }));
}

const def = (key: string, format: BenchmarkMetricDef["format"] = "ratio"): BenchmarkMetricDef => ({
  key,
  label: key,
  format,
  higherIsBetter: true,
  description: "test",
});

describe("typed omp metric adapters", () => {
  test("known keys are typed; unknown + prototype keys refuse", () => {
    expect(isOmpMetricKey("pass_rate")).toBe(true);
    expect(isOmpMetricKey("projected_fail_rate")).toBe(true);
    expect(isOmpMetricKey("nope")).toBe(false);
    expect(isOmpMetricKey("toString")).toBe(false);
    expect(isOmpMetricKey("__proto__")).toBe(false);
  });

  test("each adapter computes the expected value", () => {
    const r = rows(["done", "done", "failed", "pending"]);
    expect(computeBenchmarkMetric(def("total", "count"), r).value).toBe(4);
    expect(computeBenchmarkMetric(def("done", "count"), r).value).toBe(2);
    expect(computeBenchmarkMetric(def("failed", "count"), r).value).toBe(1);
    expect(computeBenchmarkMetric(def("pending", "count"), r).value).toBe(1);
    expect(computeBenchmarkMetric(def("pass_rate"), r).value).toBeCloseTo(0.5, 9);
    expect(computeBenchmarkMetric(def("fail_rate"), r).value).toBeCloseTo(0.25, 9);
  });

  test("formatting follows the declared format", () => {
    expect(computeBenchmarkMetric(def("pass_rate"), rows(["done"])).formatted).toBe("1.0000");
    expect(computeBenchmarkMetric(def("total", "count"), rows(["done"])).formatted).toBe("1");
  });

  test("unknown metric key fails closed", () => {
    expect(() => computeBenchmarkMetric(def("does_not_exist"), [])).toThrow(/typed adapter is required/);
  });

  test("all shipped definitions have adapters", () => {
    const values = computeDefaultBenchmarkMetrics(rows(["done", "failed"]));
    expect(values.map((v) => v.key).sort()).toEqual(["fail_rate", "pass_rate", "pending"]);
  });
});

describe("in-flight linear projection beyond projectedPassRate", () => {
  test("resolves pending rows at the observed done:failed ratio", () => {
    // 4 rows: 1 done, 1 failed, 2 pending → observed ratio 50:50 → project 2 done / 2 failed.
    const p = inFlightProjection(rows(["done", "failed", "pending", "pending"]));
    expect(p.basis).toBe("observed");
    expect(p.projectedPassRate).toBeCloseTo(0.5, 9);
    expect(p.projectedFailRate).toBeCloseTo(0.5, 9);
    expect(p.observedPassRate).toBeCloseTo(0.25, 9);
  });

  test("all-pending set is honestly unresolved (no invented 50%)", () => {
    const p = inFlightProjection(rows(["pending", "pending"]));
    expect(p.basis).toBe("none");
    expect(p.projectedPassRate).toBe(0);
    expect(p.projectedFailRate).toBe(0);
  });

  test("empty set is safe", () => {
    const p = inFlightProjection([]);
    expect(p.total).toBe(0);
    expect(p.projectedPassRate).toBe(0);
    expect(p.basis).toBe("none");
  });
});

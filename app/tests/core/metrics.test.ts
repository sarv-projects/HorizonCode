/** metrics.test.ts — the metric contract (H-7, docs/16 §2.4.3). */

import { describe, expect, test } from "bun:test";
import { isPublishable, metricContract } from "../../src/core/metrics";

const complete = {
  metric: "p95 tool dispatch latency",
  anchor: "none — first measurement",
  population: "ref-linux-x64-4c8g, tool-roundtrip suite, N=200",
  excludes: "guard/lease time (measured separately in hz.effect spans)",
  value: "14 ms",
};

describe("metric contract (H-7)", () => {
  test("a complete number renders with all four slots in order", () => {
    const text = metricContract(complete);
    expect(text.split("\n")).toEqual([
      "metric: p95 tool dispatch latency",
      "anchor: none — first measurement",
      "population: ref-linux-x64-4c8g, tool-roundtrip suite, N=200",
      "excludes: guard/lease time (measured separately in hz.effect spans)",
      "value: 14 ms",
    ]);
  });

  test("a run id is carried when present", () => {
    const text = metricContract({ ...complete, runId: "run-42" });
    expect(text).toContain("run_id: run-42");
  });

  test.each(["metric", "anchor", "population", "excludes"] as const)("a number missing %s is refused, naming it", (slot) => {
    const broken = { ...complete, [slot]: "" };
    expect(() => metricContract(broken)).toThrow(slot);
    expect(() => metricContract(broken)).toThrow("not a result");
    expect(isPublishable(broken)).toBe(false);
  });

  test("whitespace-only slots are as missing as absent ones", () => {
    expect(() => metricContract({ ...complete, excludes: "   " })).toThrow("excludes");
  });

  test("a missing value is refused", () => {
    expect(() => metricContract({ ...complete, value: "" })).toThrow("value");
  });

  test("isPublishable is true exactly for complete numbers", () => {
    expect(isPublishable(complete)).toBe(true);
    expect(isPublishable(null)).toBe(false);
    expect(isPublishable({ value: 3 })).toBe(false);
  });
});

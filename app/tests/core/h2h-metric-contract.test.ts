/**
 * h2h-metric-contract.test.ts -- H-7 contract for `hzcode h2h` numbers.
 * Dry-run default: no competitor invoked, no pass rates invented.
 */
import { describe, expect, test } from "bun:test";
import {
  defaultH2HTasks,
  h2hPublication,
  runHeadToHeadBench,
  type H2HCompetitorDiscovery,
} from "../../src/core/head-to-head-bench";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";

const competitors: H2HCompetitorDiscovery[] = [
  { id: "horizoncode", available: true, binary: "/usr/bin/hzcode", detail: "found" },
  { id: "codex", available: false, detail: "no binary on PATH" },
];

describe("h2h H-7 metric contracts", () => {
  test("h2hPublication contracts dry-run counts with honest population/excludes", () => {
    const report = runHeadToHeadBench({ tasks: defaultH2HTasks(3), competitors, live: false });
    const blocks = h2hPublication(report);
    expect(blocks).toHaveLength(4);
    for (const block of blocks) assertPublishedNumber(block);
    const values = blocks.map((b) => Number(parsePublishedNumber(b).value));
    // tasks, competitors, planned arms (3×2), available competitors
    expect(values).toEqual([3, 2, 6, 1]);
    expect(parsePublishedNumber(blocks[0]!).excludes).toMatch(/no competitor invoked|no pass rate/i);
  });

  test("live scaffold still publishes counts but never a pass rate", () => {
    const report = runHeadToHeadBench({ tasks: defaultH2HTasks(2), competitors, live: true });
    const blocks = h2hPublication(report);
    for (const block of blocks) assertPublishedNumber(block);
    expect(blocks.some((b) => parsePublishedNumber(b).metric.toLowerCase().includes("pass"))).toBe(false);
  });

  test("NEGATIVE: a bare number is not a publishable claim", () => {
    expect(() => assertPublishedNumber("6")).toThrow(/unpublished numeric claim/i);
    expect(() => assertPublishedNumber("planned arms = 6")).toThrow(/unpublished numeric claim/i);
  });
});

/** metrics.test.ts — the metric contract (H-7, docs/16 §2.4.3). */

import { describe, expect, test } from "bun:test";
import { assertPublishedNumber, isPublishable, metricContract, parsePublishedNumber } from "../../src/core/metrics";
import type { PostmortemRecord } from "../../src/core/postmortem";

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

describe("publication assertion (H-7 consumption half)", () => {
  test("a contracted block parses back to its slots, including run_id", () => {
    const block = metricContract({ ...complete, value: 42, runId: "run-7" });
    expect(parsePublishedNumber(block)).toEqual({ ...complete, value: "42", runId: "run-7" });
    expect(() => assertPublishedNumber(block, "p95 tool dispatch latency")).not.toThrow();
  });

  test("a multi-line value round-trips", () => {
    const block = metricContract({ ...complete, value: "14 ms\n(p99 40 ms)" });
    expect(parsePublishedNumber(block).value).toBe("14 ms\n(p99 40 ms)");
  });

  test.each([
    ["a bare number", "42"],
    ["a hand-written claim", "p95 = 14ms"],
    ["a blank value", "metric: x\nanchor: none\npopulation: N=1\nexcludes: none\nvalue: "],
  ])("rejects %s as an unpublished numeric claim", (_label, block) => {
    expect(() => assertPublishedNumber(block)).toThrow("unpublished numeric claim");
  });

  test("rejects a block with a missing slot, naming it", () => {
    const block = metricContract(complete).replace(/\nexcludes: [^\n]*/, "");
    expect(() => assertPublishedNumber(block)).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber(block)).toThrow(/excludes|missing/);
  });

  test("expectedMetric must match the Metric slot", () => {
    expect(() => assertPublishedNumber(metricContract(complete), "a different metric")).toThrow(
      "unpublished numeric claim",
    );
  });

  test("every number evals.ts publishes is a contracted block (H-7 scoped route)", async () => {
    const { runEvalSet, summarizeEvalSet } = await import("../../src/core/evals");
    const sample = {
      id: "c1",
      from: "pm1",
      task: "do the thing",
      setup: { tools: ["read"] },
      assertions: [{ kind: "terminal" as const, value: "succeeded" as const }, { kind: "no_answer_leak" as const }],
    };
    for (const block of summarizeEvalSet([sample]).published) assertPublishedNumber(block);
    const run = await runEvalSet([sample], {
      executor: async () => ({ terminal: "succeeded", finalAnswer: "done" }),
      forbiddenTexts: ["SECRET"],
    });
    expect(run.aggregate.published.length).toBeGreaterThan(0);
    for (const block of run.aggregate.published) assertPublishedNumber(block);
  });

  test("NEGATIVE (ruling 510): an un-contracted bare number is refused", () => {
    // A bare number, and a hand-written numeric line, are NOT results. The
    // consumer half of the contract must refuse them, naming the reason.
    expect(() => assertPublishedNumber("42")).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber("read: 3")).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber("session corpus: 2 post-mortem(s)")).toThrow("unpublished numeric claim");
  });

  test("ruling 510 sweep: every published number in the owned surfaces is contracted", async () => {
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { recordPostmortem } = await import("../../src/core/postmortem");
    const { histogramFromPostmortems, suggestCorpusTuning } = await import("../../src/core/session-corpus-stats");
    const { benchGroundTruthPublication, stimulusFromIndex, buildIndexedEvalCases } = await import(
      "../../src/core/bench-ground-truth"
    );
    const { runSessionStatsCli } = await import("../../src/session-stats");

    const record = { terminal: "failed", failureClass: "tool_error", toolCalls: { read: 4 } } as PostmortemRecord;

    // session-corpus-stats.ts publication surfaces
    const blocks: string[] = [
      ...histogramFromPostmortems([record]).published,
      ...suggestCorpusTuning([record]).published,
      // bench-ground-truth.ts publication surfaces
      ...benchGroundTruthPublication(),
      ...stimulusFromIndex(2).published,
      ...buildIndexedEvalCases(2).flatMap((c) => c.published),
    ];

    // session-stats.ts CLI --json publication surface (includes load status).
    const dir = mkdtempSync(path.join(os.tmpdir(), "metric-sweep-"));
    await recordPostmortem({
      stateDir: dir,
      sessionId: "sweep",
      terminal: "failed",
      failureClass: "tool_error",
      transcript: "task text",
      toolCalls: { read: 4 },
      now: 1_700_000_000_000,
    });
    const original = console.log;
    let out = "";
    console.log = (text?: unknown) => {
      out += `${String(text)}\n`;
    };
    let code = 0;
    try {
      code = await runSessionStatsCli(["--postmortems", dir, "--json"]);
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    const cli = JSON.parse(out.trim()) as { published: string[] };
    expect(cli.published.length).toBeGreaterThan(0);
    blocks.push(...cli.published);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) assertPublishedNumber(block);
  });
});

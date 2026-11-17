/** metric-contract-publications.test.ts — H-7 repo sweep (scoped to the four named modules). */

import { describe, expect, test } from "bun:test";
import type { HzConfig } from "../../src/core/config";
import { evalExecutorPublication } from "../../src/core/eval-executor";
import { benchmarkManagerPublication } from "../../src/core/benchmark-manager";
import { settingsReportPublication } from "../../src/core/settings-report";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";
import { runEvalSet, type PostmortemEvalCase } from "../../src/core/evals";
import { evalRunPublication } from "../../src/eval-run";

const CASE: PostmortemEvalCase = {
  id: "c1",
  from: "pm1",
  task: "do the thing",
  setup: { tools: ["read"] },
  assertions: [{ kind: "terminal", value: "succeeded" }, { kind: "no_answer_leak" }],
};

describe("H-7 sweep: every published number in the named modules is a contracted block", () => {
  test("eval-executor observations publication", () => {
    const blocks = evalExecutorPublication([
      { caseId: "c1", workspace: "/tmp/ws", terminal: "succeeded", toolCalls: ["read"], textChars: 4, submission: "done", model: "m", sessionId: "s", durationMs: 12, kept: false },
      { caseId: "c2", workspace: "/tmp/ws", terminal: "succeeded", toolCalls: [], textChars: 2, submission: "ok", model: "m", sessionId: "s", durationMs: 8, kept: false },
    ]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) assertPublishedNumber(block);
  });

  test("benchmark-manager report publication", () => {
    const rows = [
      { id: "armA-1", task: "t", status: "done" as const },
      { id: "armA-2", task: "t", status: "failed" as const },
      { id: "armB-1", task: "t", status: "pending" as const },
    ];
    const blocks = benchmarkManagerPublication(rows);
    for (const block of blocks) assertPublishedNumber(block);
    const parsed = parsePublishedNumber(blocks[0]!);
    expect(parsed.metric).toBe("benchmark arms");
    expect(parsed.value).toBe("2");
  });

  test("settings-report publication (counts only, no secrets/paths)", () => {
    const config: HzConfig = {
      provider: "mock",
      model: "mock-1",
      sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
      mcp: { servers: [{ id: "a", command: "x", args: [] }] } as HzConfig["mcp"],
      lsp: { servers: [] } as HzConfig["lsp"],
      budget: { maxSteps: 12 },
    };
    const blocks = settingsReportPublication({ workspace: "/tmp/ws", home: "/tmp/home", config, env: {} });
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) assertPublishedNumber(block);
    const joined = blocks.join("\n");
    expect(joined).not.toContain("/tmp/home");
    expect(joined).not.toContain("apiKey");
  });

  test("eval-run CLI publication", async () => {
    const run = await runEvalSet([CASE], {
      executor: async () => ({ terminal: "succeeded", finalAnswer: "done" }),
      forbiddenTexts: ["SECRET"],
    });
    const blocks = evalRunPublication(run, 2);
    for (const block of blocks) assertPublishedNumber(block);
    const parsed = parsePublishedNumber(blocks[2]!);
    expect(parsed.metric).toContain("skipped");
    expect(parsed.value).toBe("2");
  });

  test("NEGATIVE: a bare number is not a result on any surface", () => {
    expect(() => assertPublishedNumber("3 mcp servers")).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber("12")).toThrow("unpublished numeric claim");
  });
});

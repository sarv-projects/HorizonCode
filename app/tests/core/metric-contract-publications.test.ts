/** metric-contract-publications.test.ts — H-7 repo sweep (scoped to the four named modules). */

import { describe, expect, test } from "bun:test";
import type { HzConfig } from "../../src/core/config";
import { evalExecutorPublication } from "../../src/core/eval-executor";
import { benchmarkManagerPublication } from "../../src/core/benchmark-manager";
import { settingsReportPublication } from "../../src/core/settings-report";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";
import { runEvalSet, type PostmortemEvalCase } from "../../src/core/evals";
import {
  batchDryRunPublication,
  batchSelectionPublication,
  batchStatusPublication,
} from "../../src/batch-run";
import { convoExportPublication, sessionExportPublication, sessionForkPublication, sessionListPublication } from "../../src/core/session-cli";
import { sessionVerifyPublication } from "../../src/core/session-verify-cli";
import { receiptShowPublication } from "../../src/core/receipt-cli";
import { configCheckPublication } from "../../src/core/config";
import { doctorPublication } from "../../src/core/doctor";
import { modelsListPublication, modelsRefreshPublication } from "../../src/core/catalog/catalog";
import { unknownExportPublication } from "../../src/core/unknown-evidence";
import { evalRunPublication, swebenchSubmitPublication } from "../../src/eval-run";

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

  test("swebench submit publication (ruling 568)", () => {
    const blocks = swebenchSubmitPublication({ predictionCount: 7, harness: "swebench-official" });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("7");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("swebench-official");
  });

  test("config check publication (ruling 595)", () => {
    const blocks = configCheckPublication({
      file: "/tmp/x.json",
      exists: true,
      unknown: ["a", "b"],
      rejected: ["bad"],
    } as never);
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("2");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("1");
    expect(parsePublishedNumber(blocks[2]!).value).toBe("1");
  });

  test("models refresh publication (ruling 598)", () => {
    const changed = modelsRefreshPublication({ providerCount: 4, unchanged: false });
    for (const block of changed) assertPublishedNumber(block);
    expect(parsePublishedNumber(changed[0]!).value).toBe("4");
    expect(parsePublishedNumber(changed[1]!).value).toBe("0");
    const same = modelsRefreshPublication({ providerCount: 4, unchanged: true });
    expect(parsePublishedNumber(same[1]!).value).toBe("1");
  });


  test("doctor publication (ruling 606)", () => {
    const blocks = doctorPublication([
      { id: "a", status: "ok", summary: "fine" },
      { id: "b", status: "warn", summary: "hmm" },
      { id: "c", status: "fail", summary: "bad" },
    ] as never);
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("1");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("1");
    expect(parsePublishedNumber(blocks[2]!).value).toBe("1");
  });

  test("models list publication (ruling 602)", () => {
    const blocks = modelsListPublication({ listed: 11, provider: "mock" });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("11");
  });

  test("receipt show publication (ruling 592)", () => {
    const blocks = receiptShowPublication({ found: true, chainOk: false });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("1");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("0");
  });

  test("session verify publication (ruling 591)", () => {
    const blocks = sessionVerifyPublication({
      workspace: "/tmp",
      sessionId: "s1",
      sessionFound: true,
      chain: { ok: true, label: "receipts", count: 0 } as never,
      compactionChains: [],
      reconcile: { mismatches: [{}, {}], rows: [] } as never,
      evidence: { failures: [] } as never,
      postimageReplayEnabled: false,
      nestedReceipts: { ok: true } as never,
      nestedEventStreams: { ok: true } as never,
      openUnknownCount: 2,
      ok: false,
    });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("0");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("2");
    expect(parsePublishedNumber(blocks[2]!).value).toBe("2");
  });


  test("session fork publication (ruling 608)", () => {
    const blocks = sessionForkPublication({ messageIndex: 7 });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("7");
  });

  test("session list publication (ruling 590)", () => {
    const blocks = sessionListPublication({ listed: 3, limit: 20 });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("3");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("20");
  });

  test("session export publication (ruling 570)", () => {
    const blocks = sessionExportPublication({ messageCount: 4, checkpointCount: 1, eventCount: 9 });
    for (const block of blocks) assertPublishedNumber(block);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("4");
    expect(parsePublishedNumber(blocks[1]!).value).toBe("1");
    expect(parsePublishedNumber(blocks[2]!).value).toBe("9");
  });

  test("convo / unknown export publications (ruling 574)", () => {
    const convo = convoExportPublication({ messageCount: 3, format: "html" });
    for (const block of convo) assertPublishedNumber(block);
    expect(parsePublishedNumber(convo[0]!).value).toBe("3");
    const unk = unknownExportPublication({ effectCount: 5 });
    for (const block of unk) assertPublishedNumber(block);
    expect(parsePublishedNumber(unk[0]!).value).toBe("5");
  });

  test("batch selection/status/dry-run publications (ruling 578)", () => {
    const sel = batchSelectionPublication({ selected: 2, total: 9 });
    for (const block of sel) assertPublishedNumber(block);
    expect(parsePublishedNumber(sel[0]!).value).toBe("2");
    expect(parsePublishedNumber(sel[1]!).value).toBe("9");
    const st = batchStatusPublication({ pending: 4, total: 7 });
    for (const block of st) assertPublishedNumber(block);
    expect(parsePublishedNumber(st[0]!).value).toBe("4");
    const dry = batchDryRunPublication({ pending: 3 });
    for (const block of dry) assertPublishedNumber(block);
    expect(parsePublishedNumber(dry[0]!).value).toBe("3");
  });

  test("NEGATIVE: a bare number is not a result on any surface", () => {
    expect(() => assertPublishedNumber("3 mcp servers")).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber("12")).toThrow("unpublished numeric claim");
  });
});

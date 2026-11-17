/**
 * metric-contract-repo-sweep.test.ts — H-7 repo-wide sweep (ruling 529).
 *
 * Enumerates every NEW contracted publication surface added by the repo-wide
 * sweep and proves each block is a complete Metric/Anchor/Population/Excludes
 * contract. The default human-readable text of every contributing renderer is
 * asserted byte-identical where it is cheap to do so; the contracts are a
 * parallel machine-readable surface, per the 505/510/519 precedent. At least
 * one negative test proves an un-contracted bare number is still refused.
 */

import { describe, expect, test } from "bun:test";
import { assertPublishedNumber, isPublishable, parsePublishedNumber } from "../../src/core/metrics";
import type { DoctorCheck } from "../../src/core/doctor";
import { doctorPublication, renderDoctor, renderDoctorJson } from "../../src/core/doctor";
import { REVIEW_FORK_ORIGIN, reviewForkPublication, formatReviewForkNotice, type ReviewForkRunResult } from "../../src/core/review";
import { conversationPublication, renderStats, chainLine, type ConvoStats } from "../../src/core/convo";
import { receiptChainVerifyPublication, formatReceiptChainVerifySummary } from "../../src/core/receipt-chain-verify";
import { learningGraphPublication } from "../../src/core/learning-graph";
import { agentGraphPublication } from "../../src/core/agent-graph";
import { toolSearchPublication } from "../../src/tools/tool-search";
import type { StoredProposalRow } from "../../src/core/curator";

const CHECKS: DoctorCheck[] = [
  { id: "a", label: "alpha", status: "ok", detail: "fine" },
  { id: "b", label: "beta", status: "warn", detail: "careful", hint: "fix it" },
  { id: "c", label: "gamma", status: "fail", detail: "broken", hint: "repair it" },
];

const RESULT: ReviewForkRunResult = {
  origin: REVIEW_FORK_ORIGIN,
  status: "ok",
  appended: [{ digest: "d1", kind: "memory", title: "one" }],
  duplicates: ["dupe"],
  refusedProposals: [],
  spend: { reservedUsd: 0.01, actualUsd: 0.008, settled: true },
};

const STATS: ConvoStats = { messages: 4, byRole: { user: 2, assistant: 2 }, toolCalls: 3, estimatedTokens: 120 };

const PROPOSAL: StoredProposalRow = {
  schemaVersion: 1,
  kind: "memory",
  title: "a proposal",
  body: "body",
  evidence: ["e1"],
  reads: ["src/a.ts"],
  digest: "abcd1234",
  origin: REVIEW_FORK_ORIGIN,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function everyBlockIsContracted(blocks: string[], label: string): void {
  expect(blocks.length, label).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(() => assertPublishedNumber(block), label).not.toThrow();
    const parsed = parsePublishedNumber(block);
    expect(isPublishable(parsed), label).toBe(true);
    for (const slot of ["metric", "anchor", "population", "excludes", "value"] as const) {
      expect(parsed[slot]?.trim(), `${label}: ${slot}`).not.toBe("");
    }
  }
}

describe("H-7 repo sweep: newly contracted published numbers (ruling 529)", () => {
  test("doctor status counts are contracted, human table unchanged, JSON additive", () => {
    everyBlockIsContracted(doctorPublication(CHECKS), "doctor");
    const values = doctorPublication(CHECKS).map((b) => parsePublishedNumber(b).value);
    expect(values).toEqual(["1", "1", "1"]);
    const metrics = doctorPublication(CHECKS).map((b) => parsePublishedNumber(b).metric);
    expect(metrics).toEqual(["doctor checks ok", "doctor checks warning", "doctor checks failure"]);

    // The human table keeps its shape: no contract block leaks into it.
    const human = renderDoctor(CHECKS);
    expect(human).toContain("1 ok, 1 warning(s), 1 failure(s)");
    expect(human).toContain("[FAIL] gamma");
    expect(human).toContain("fix: repair it");
    for (const slot of ["metric:", "anchor:", "population:", "excludes:", "value:"]) {
      expect(human).not.toContain(slot);
    }
    // Machine form gains an additive `published` field, existing keys intact.
    const json = JSON.parse(renderDoctorJson(CHECKS)) as {
      ok: boolean;
      summary: { ok: number; warn: number; fail: number };
      published: string[];
    };
    expect(json.ok).toBe(false);
    expect(json.summary).toEqual({ ok: 1, warn: 1, fail: 1 });
    everyBlockIsContracted(json.published, "doctor JSON published");
  });

  test("review fork counts and spend are contracted; human notice unchanged", () => {
    const blocks = reviewForkPublication(RESULT);
    everyBlockIsContracted(blocks, "review fork");
    expect(blocks.map((b) => parsePublishedNumber(b).metric)).toEqual([
      "review fork proposals appended",
      "review fork proposals duplicate",
      "review fork proposals refused",
      "review fork spend reserved",
      "review fork spend actual",
    ]);
    expect(formatReviewForkNotice(RESULT)).toBe(
      "review fork: 1 proposal(s) appended, 1 duplicate(s), 0 refused — store ?",
    );
    // A refused run publishes nothing (no curation happened).
    expect(reviewForkPublication({ ...RESULT, status: "refused" })).toEqual([]);
  });

  test("conversation stats and receipt count are contracted; human strings unchanged", () => {
    const blocks = conversationPublication(STATS, { ok: true, count: 7 });
    everyBlockIsContracted(blocks, "conversation");
    expect(blocks.map((b) => parsePublishedNumber(b).value)).toEqual(["4", "3", "120", "7"]);
    expect(renderStats(STATS)).toBe("4 message(s) (user 2, assistant 2), 3 tool call(s), ~120 tokens (local estimate)");
    expect(chainLine({ ok: true, count: 7 })).toBe("receipt chain verified: 7 receipt(s)");
    // Without a chain, only the three stats blocks are published.
    expect(conversationPublication(STATS).length).toBe(3);
  });

  test("receipt chain verified count is contracted; broken chain states its exclusion", () => {
    const okBlocks = receiptChainVerifyPublication({ ok: true, count: 2 });
    everyBlockIsContracted(okBlocks, "receipt chain ok");
    expect(parsePublishedNumber(okBlocks[0]!).value).toBe("2");
    expect(formatReceiptChainVerifySummary({ ok: true, count: 2 })).toEqual(["receipt chain: ok (2 receipt(s))"]);

    const broken = receiptChainVerifyPublication({ ok: false, count: 1, brokenAt: 2 });
    everyBlockIsContracted(broken, "receipt chain broken");
    expect(parsePublishedNumber(broken[0]!).excludes).toContain("seq 2");
    expect(formatReceiptChainVerifySummary({ ok: false, count: 1, brokenAt: 2 })).toEqual([
      "receipt chain: broken",
      "  brokenAt seq 2",
      "  verified prefix count 1",
    ]);
    // A refusal publishes no measurement.
    expect(receiptChainVerifyPublication({ ok: false, count: 0, refusal: "unreadable" })).toEqual([]);
  });

  test("learning graph node/edge/proposal counts are contracted", () => {
    const blocks = learningGraphPublication([PROPOSAL, { ...PROPOSAL, digest: "efgh5678", reads: ["src/a.ts"] }]);
    everyBlockIsContracted(blocks, "learning graph");
    expect(blocks.map((b) => parsePublishedNumber(b).metric)).toEqual([
      "learning graph proposals in store",
      "learning graph nodes",
      "learning graph edges",
      "learning graph total edges",
    ]);
  });

  test("agent graph object/node/edge counts are contracted", () => {
    const blocks = agentGraphPublication({
      sessions: [{ id: "s1", tools: ["read"] }],
      tools: ["read", "grep"],
      skills: [{ name: "skill-x" }],
      proposals: [{ digest: "d1", title: "p", kind: "memory" }],
    });
    everyBlockIsContracted(blocks, "agent graph");
    expect(blocks.map((b) => parsePublishedNumber(b).metric)).toEqual([
      "agent graph objects in view",
      "agent graph nodes rendered",
      "agent graph edges rendered",
      "agent graph total edges",
    ]);
  });

  test("tool-search unlocked count is contracted", () => {
    const blocks = toolSearchPublication([{ name: "read" }, { name: "grep" }]);
    everyBlockIsContracted(blocks, "tool search");
    expect(blocks.length).toBe(1);
    expect(parsePublishedNumber(blocks[0]!).value).toBe("2");
    expect(parsePublishedNumber(blocks[0]!).metric).toBe("tool search unlocked tools");
  });

  test("NEGATIVE: an un-contracted bare number is refused on every surface", () => {
    for (const bare of [
      "2",
      "42",
      "Unlocked 3 tool(s)",
      "receipt chain: ok (2 receipt(s))",
      "4 message(s), 3 tool call(s)",
      "1 ok, 1 warning(s), 1 failure(s)",
    ]) {
      expect(() => assertPublishedNumber(bare)).toThrow("unpublished numeric claim");
      expect(isPublishable(bare)).toBe(false);
    }
  });

  test("NEGATIVE: a block missing a slot is refused even on a new surface", () => {
    const complete = doctorPublication(CHECKS)[0]!;
    const missingExcludes = complete.split("\n").filter((l) => !l.startsWith("excludes:")).join("\n");
    expect(() => assertPublishedNumber(missingExcludes)).toThrow("unpublished numeric claim");
    expect(() => assertPublishedNumber(missingExcludes)).toThrow(/excludes|missing/);
  });
});

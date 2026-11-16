/**
 * review-fork.test.ts — G-1 (docs/28 ruling 27): the runnable review fork.
 *
 * Pins the six required behaviours: prefix-parity refusal (build AND dispatch),
 * the closed read-only tool subset, `origin: review-fork` attribution, opt-in
 * gating (off = no provider call), SpendLedger reservation/refusal before any
 * call, and one end-to-end scheduled fork whose proposals land as canonical
 * curator rows (never workspace writes, ADR-010).
 *
 * Hermetic: temp workspaces/state dirs, scripted provider, no network, no tight
 * wall-clock bounds. Spend is recorded through the real SpendLedger on a temp
 * workspace, never a live provider.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Provider, ProviderEvent, ProviderRequest } from "../../src/contracts";
import { sha256Hex } from "../../src/contracts";
import { proposalsFilePath, type StoredProposalRow } from "../../src/core/curator";
import {
  buildReviewFork,
  maybeRunReviewFork,
  parentPrefixRecord,
  parseReviewProposals,
  REVIEW_FORK_TOOLS,
  reviewForkEnabled,
  ReviewForkError,
  reviewRequestTail,
  reviewToolSpecs,
  runReviewFork,
  verifyReviewForkSpec,
  type ReviewForkRunResult,
  type ReviewForkSpend,
  type ReviewForkSpec,
  type ReviewTranscriptEvent,
} from "../../src/core/review";
import { createScriptedProvider, textTurn, toolCallTurn } from "../../src/core/providers/scripted";
import { SpendLedger } from "../../src/core/spend-ledger";
import { cleanupTemps, readLines, tempDir } from "./helpers";

afterAll(cleanupTemps);

/* -------------------------------- fixtures -------------------------------- */

const PARENT_PREFIX = "SYSTEM: horizoncode v0.1\nTOOLS: [read,grep,glob,shell]\nCONFIG: {provider:\"mock\"}\n";
const EVENTS: ReviewTranscriptEvent[] = [
  { id: "msg_1", type: "user", summary: "fix the parser test" },
  { id: "msg_2", type: "assistant" },
];

const VALID_PROPOSALS = [
  {
    kind: "memory",
    title: "Prefer the canonical serializer for stored rows",
    body: "Hash store rows with the canonical helper so digests stay byte-stable across runs.",
    evidence: ["msg_1"],
    reads: [],
  },
];

function fixture(): { workspace: string; stateDir: string } {
  const workspace = tempDir("hz-review-fork-ws-");
  return { workspace, stateDir: path.join(workspace, ".hz", "state") };
}

function makeSpec(stateDir: string, workspace: string, bytes = PARENT_PREFIX): ReviewForkSpec {
  return buildReviewFork({
    parentPrefix: parentPrefixRecord(bytes),
    transcript: EVENTS,
    workspace,
    stateDir,
  });
}

/** A fork result asserted to be a refusal, with a typed reason. */
function expectRefused(result: ReviewForkRunResult, reason: string): void {
  expect(result.status).toBe("refused");
  expect(result.reason).toBe(reason);
  expect(result.appended.length).toBe(0);
}

/* ------------------------- 1. prefix parity refusal ------------------------- */

describe("prefix parity (build + dispatch)", () => {
  test("buildReviewFork refuses a record whose recorded sha disagrees with the bytes", () => {
    const { workspace, stateDir } = fixture();
    expect(() =>
      buildReviewFork({
        parentPrefix: { bytes: PARENT_PREFIX, sha256: sha256Hex("not the parent bytes") },
        transcript: [],
        workspace,
        stateDir,
      }),
    ).toThrow(ReviewForkError);
    try {
      buildReviewFork({
        parentPrefix: { bytes: PARENT_PREFIX, sha256: "0".repeat(64) },
        transcript: [],
        workspace,
        stateDir,
      });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as ReviewForkError).reason).toBe("prefix-parity-mismatch");
    }
  });

  test("runReviewFork refuses a tampered prefix BEFORE any provider call", async () => {
    const { workspace, stateDir } = fixture();
    const spec = makeSpec(stateDir, workspace);
    const tampered: ReviewForkSpec = { ...spec, systemPrefix: `${spec.systemPrefix} ` };
    let called = 0;
    const provider: Provider = {
      name: "sentinel",
      async *stream(): AsyncIterable<ProviderEvent> {
        called += 1;
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await runReviewFork(tampered, {
      provider,
      model: "mock-1",
      spend: new SpendLedger(workspace, { limitMicroUsd: 1_000_000 }),
    });
    expectRefused(result, "prefix-parity-mismatch");
    expect(called).toBe(0);
    expect(result.spend.reservedUsd).toBe(0); // no reservation on a parity refusal
  });
});

/* ------------------------ 2. closed read-only subset ------------------------ */

describe("closed read-only tool subset", () => {
  test("the subset is exactly read/grep/glob, all fs.read / read-only", () => {
    expect(REVIEW_FORK_TOOLS.map((tool) => tool.name)).toEqual(["read", "grep", "glob"]);
    expect(REVIEW_FORK_TOOLS.every((tool) => tool.guardKind === "fs.read" && tool.effectClass === "read-only")).toBe(
      true,
    );
    expect(reviewToolSpecs().map((spec) => spec.name)).toEqual(["read", "grep", "glob"]);
  });

  test("a widened spec tool list is refused at dispatch", () => {
    const { workspace, stateDir } = fixture();
    const spec = makeSpec(stateDir, workspace);
    const widened: ReviewForkSpec = {
      ...spec,
      tools: [...spec.tools, { name: "write", guardKind: "fs.read", effectClass: "read-only" } as never],
    };
    expect(() => verifyReviewForkSpec(widened)).toThrow(ReviewForkError);
  });

  test("a model tool_call outside the subset is refused and applies nothing", async () => {
    const { workspace, stateDir } = fixture();
    const spec = makeSpec(stateDir, workspace);
    const provider = createScriptedProvider([toolCallTurn({ name: "write", args: { path: "x" } })]);
    const result = await runReviewFork(spec, {
      provider,
      model: "mock-1",
      spend: new SpendLedger(workspace, { limitMicroUsd: 1_000_000 }),
      reserveUsd: 0.01,
    });
    expectRefused(result, "tool-outside-subset");
    expect(result.spend.settled).toBe(true); // the call happened and was paid for
    expect(existsSync(proposalsFilePath(stateDir))).toBe(false);
  });
});

/* -------------------------- 3. origin attribution -------------------------- */

describe("origin attribution + curator application", () => {
  test("returned proposals become review-fork rows; no workspace writes", async () => {
    const { workspace, stateDir } = fixture();
    const spec = makeSpec(stateDir, workspace);
    const provider = createScriptedProvider([textTurn(JSON.stringify(VALID_PROPOSALS))]);
    const result = await runReviewFork(spec, {
      provider,
      model: "mock-1",
      spend: new SpendLedger(workspace, { limitMicroUsd: 1_000_000 }),
      reserveUsd: 0.01,
      now: () => "2026-11-16T00:00:00.000Z",
    });
    expect(result.status).toBe("ok");
    expect(result.appended.length).toBe(1);
    expect(result.storePath).toBe(proposalsFilePath(stateDir));
    const rows = readLines(proposalsFilePath(stateDir)).map((line) => JSON.parse(line) as StoredProposalRow);
    expect(rows.length).toBe(1);
    expect(rows[0]?.origin).toBe("review-fork");
    expect(rows[0]?.kind).toBe("memory");
    // The only effect is the curator store under stateDir.
    expect(existsSync(path.join(workspace, "AGENTS.md"))).toBe(false);
  });
});

/* ------------------------------ 4. opt-in gate ------------------------------ */

describe("opt-in gating", () => {
  test("reviewForkEnabled only on an explicit =1", () => {
    expect(reviewForkEnabled({})).toBe(false);
    expect(reviewForkEnabled({ HZ_REVIEW_FORK: "0" })).toBe(false);
    expect(reviewForkEnabled({ HZ_REVIEW_FORK: "true" })).toBe(false);
    expect(reviewForkEnabled({ HZ_REVIEW_FORK: "1" })).toBe(true);
  });

  test("gate off makes no provider call and writes no store", async () => {
    const { workspace, stateDir } = fixture();
    const provider = createScriptedProvider([textTurn(JSON.stringify(VALID_PROPOSALS))]);
    const notices: string[] = [];
    const result = await maybeRunReviewFork(() => makeSpec(stateDir, workspace), {
      enabled: false,
      provider,
      model: "mock-1",
      spend: new SpendLedger(workspace, { limitMicroUsd: 1_000_000 }),
      onNotice: (line) => notices.push(line),
    });
    expect(result).toBeUndefined();
    expect(provider.consumed()).toBe(0);
    expect(existsSync(proposalsFilePath(stateDir))).toBe(false);
    expect(notices.some((line) => line.includes("disabled"))).toBe(true);
  });
});

/* --------------------------- 5. spend rails -------------------------------- */

describe("spend reservation / refusal", () => {
  test("no ledger -> refuse with a clear notice, no provider call", async () => {
    const { workspace, stateDir } = fixture();
    let called = 0;
    const provider: Provider = {
      name: "sentinel",
      async *stream(): AsyncIterable<ProviderEvent> {
        called += 1;
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await runReviewFork(makeSpec(stateDir, workspace), {
      provider,
      model: "mock-1",
      spend: undefined,
    });
    expectRefused(result, "spend-unavailable");
    expect(result.detail).toContain("no SpendLedger");
    expect(called).toBe(0);
  });

  test("an exhausted SpendLedger refuses BEFORE dispatch (spend-limit)", async () => {
    const { workspace, stateDir } = fixture();
    const ledger = new SpendLedger(workspace, { limitMicroUsd: 1 });
    ledger.reserve(0.000001); // exhaust the one-micro ceiling
    let called = 0;
    const provider: Provider = {
      name: "sentinel",
      async *stream(): AsyncIterable<ProviderEvent> {
        called += 1;
        yield { type: "done", stopReason: "end" };
      },
    };
    const result = await runReviewFork(makeSpec(stateDir, workspace), {
      provider,
      model: "mock-1",
      spend: ledger,
      reserveUsd: 0.01,
    });
    expectRefused(result, "spend-limit");
    expect(called).toBe(0);
  });

  test("reserve happens before stream and settle after, with the reported cost", async () => {
    const { workspace, stateDir } = fixture();
    const order: string[] = [];
    const spend: ReviewForkSpend = {
      reserve(usd) {
        order.push(`reserve:${usd}`);
        return { id: "res-1" };
      },
      settle(_id, usd) {
        order.push(`settle:${usd}`);
        return undefined;
      },
      release() {
        order.push("release");
        return undefined;
      },
    };
    const provider: Provider = {
      name: "instrumented",
      async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
        order.push("stream");
        yield { type: "text", text: "[]" };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 100, outputTokens: 20 } };
      },
    };
    const result = await runReviewFork(makeSpec(stateDir, workspace), {
      provider,
      model: "mock-1",
      spend,
      reserveUsd: 0.02,
    });
    expect(result.status).toBe("ok");
    const at = (prefix: string): number => order.findIndex((line) => line.startsWith(prefix));
    expect(at("reserve:")).toBe(0);
    expect(at("stream")).toBeGreaterThan(at("reserve:"));
    expect(at("settle:")).toBeGreaterThan(at("stream"));
    expect(result.spend.settled).toBe(true);
    expect(result.spend.reservationId).toBe("res-1");
  });

  test("a real ledger records spend after a successful fork", async () => {
    const { workspace, stateDir } = fixture();
    const ledger = new SpendLedger(workspace, { limitMicroUsd: 2_000_000 });
    const provider = createScriptedProvider([textTurn("[]")]);
    const result = await runReviewFork(makeSpec(stateDir, workspace), {
      provider,
      model: "mock-1",
      spend: ledger,
      reserveUsd: 0.05,
    });
    expect(result.status).toBe("ok");
    expect(result.spend.settled).toBe(true);
    expect(ledger.status().spentUsd).toBeGreaterThan(0);
    expect(ledger.status().reservations).toBe(0);
  });
});

/* ------------------------ 6. end-to-end scheduled fork ---------------------- */

describe("end-to-end scheduled fork", () => {
  test("opt-in build -> provider -> curator, byte-identical prefix, full attribution", async () => {
    const { workspace, stateDir } = fixture();
    const spec = makeSpec(stateDir, workspace);
    const provider = createScriptedProvider([textTurn(JSON.stringify(VALID_PROPOSALS))]);
    const ledger = new SpendLedger(workspace, { limitMicroUsd: 2_000_000 });
    const notices: string[] = [];

    const result = await maybeRunReviewFork(() => spec, {
      enabled: true,
      provider,
      model: "mock-1",
      spend: ledger,
      reserveUsd: 0.05,
      now: () => "2026-11-16T00:00:00.000Z",
      onNotice: (line) => notices.push(line),
    });

    expect(result?.status).toBe("ok");
    expect(result?.appended.length).toBe(1);
    expect(provider.consumed()).toBe(1);
    const request = provider.requests()[0] as ProviderRequest;
    expect(request.system).toBe(spec.systemPrefix); // byte-identical to the parent prefix
    expect(sha256Hex(request.system)).toBe(spec.cacheParity.parentSha256);
    expect(request.tools.map((tool) => tool.name)).toEqual(["read", "grep", "glob"]);
    expect(request.messages.length).toBe(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content).toContain("PARENT TRANSCRIPT");
    const rows = readLines(proposalsFilePath(stateDir)).map((line) => JSON.parse(line) as StoredProposalRow);
    expect(rows.length).toBe(1);
    expect(rows[0]?.origin).toBe("review-fork");
    expect(notices.some((line) => line.includes("1 proposal(s) appended"))).toBe(true);
    expect(ledger.status().spentUsd).toBeGreaterThan(0);
  });

  test("unparseable output is refused and applies nothing", async () => {
    const { workspace, stateDir } = fixture();
    const provider = createScriptedProvider([textTurn("not JSON at all")]);
    const result = await runReviewFork(makeSpec(stateDir, workspace), {
      provider,
      model: "mock-1",
      spend: new SpendLedger(workspace, { limitMicroUsd: 1_000_000 }),
      reserveUsd: 0.01,
    });
    expectRefused(result, "proposals-unparseable");
    expect(existsSync(proposalsFilePath(stateDir))).toBe(false);
  });

  test("parseReviewProposals accepts fences and empty output", () => {
    expect(parseReviewProposals("")).toEqual([]);
    expect(parseReviewProposals("```json\n[]\n```")).toEqual([]);
    expect(parseReviewProposals('prologue [{"kind":"memory"}] epilogue')).toEqual([{ kind: "memory" }]);
    expect(parseReviewProposals("nonsense")).toBeUndefined();
    const { workspace, stateDir } = fixture();
    expect(reviewRequestTail(makeSpec(stateDir, workspace))).toContain("msg_1");
  });
});

/**
 * G-1 detached review-fork worker (ruling 488 residual).
 *
 * Hermetic: spend is a fake ReviewForkSpend; the worker subprocess is a FAKE
 * spawner that records the job (no Bun.spawn, no provider, no network). Proves
 * spend is reserved in the parent BEFORE spawn, the closed NDJSON job carries
 * the reservation id, the detached gate requires HZ_REVIEW_FORK=1, spawn
 * failure releases the reservation, and a decoded job settles (never
 * re-reserves) via a scripted provider.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  REVIEW_FORK_ENV,
  REVIEW_FORK_DETACHED_ENV,
  REVIEW_FORK_WORKER_SUBCOMMAND,
  buildReviewFork,
  decodeReviewForkWorkerJob,
  detachedReviewForkEnabled,
  parentPrefixRecord,
  runReviewForkWorker,
  spawnDetachedReviewFork,
  type ReviewForkSpend,
  type ReviewForkWorkerJob,
  type ReviewForkSpec,
} from "../../src/core/review";
import { createScriptedProvider, textTurn } from "../../src/core/providers/scripted";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const PREFIX = "SYSTEM: horizoncode v0.1\nTOOLS: [read,grep,glob]\n";
const STATE = mkdtempSync(path.join(tmpdir(), "hz-rfw-state-"));
const WORKSPACE = mkdtempSync(path.join(tmpdir(), "hz-rfw-ws-"));

function makeSpec(): ReviewForkSpec {
  return buildReviewFork({
    parentPrefix: parentPrefixRecord(PREFIX),
    transcript: [{ id: "msg_1", type: "user", summary: "review this" }],
    workspace: WORKSPACE,
    stateDir: STATE,
  });
}

interface FakeSpend extends ReviewForkSpend {
  reserved: Array<{ usd: number; note?: string }>;
  settled: string[];
  released: string[];
}

function fakeSpend(opts: { failReserve?: boolean } = {}): FakeSpend {
  let n = 0;
  return {
    reserved: [],
    settled: [],
    released: [],
    reserve(usd, meta) {
      if (opts.failReserve) throw new Error("spend: limit");
      this.reserved.push({ usd, note: meta?.note });
      return { id: `res-${++n}` };
    },
    settle(id) {
      this.settled.push(id);
      return {} as never;
    },
    release(id) {
      this.released.push(id);
      return {} as never;
    },
  };
}

describe("G-1 detached worker gate", () => {
  test("detached mode requires BOTH HZ_REVIEW_FORK=1 and HZ_REVIEW_FORK_DETACHED=1", () => {
    expect(detachedReviewForkEnabled({})).toBe(false);
    expect(detachedReviewForkEnabled({ [REVIEW_FORK_ENV]: "1" })).toBe(false);
    expect(detachedReviewForkEnabled({ [REVIEW_FORK_DETACHED_ENV]: "1" })).toBe(false);
    expect(
      detachedReviewForkEnabled({ [REVIEW_FORK_ENV]: "1", [REVIEW_FORK_DETACHED_ENV]: "1" }),
    ).toBe(true);
  });

  test("the worker re-exec subcommand name is stable", () => {
    expect(REVIEW_FORK_WORKER_SUBCOMMAND).toBe("__review-fork-worker");
  });
});

describe("G-1 spawnDetachedReviewFork (fake subprocess)", () => {
  test("reserves spend in the parent before spawn and passes the reservation id in the job", async () => {
    const spend = fakeSpend();
    let captured: ReviewForkWorkerJob | undefined;
    let capturedPath = "";
    const notices: string[] = [];
    const outcome = await spawnDetachedReviewFork({
      spec: makeSpec(),
      model: "mock-1",
      providerName: "mock",
      workspace: WORKSPACE,
      stateDir: STATE,
      spend,
      reserveUsd: 0.01,
      spawnWorker: (job, jobPath) => {
        captured = job;
        capturedPath = jobPath;
        return { pid: 4242 };
      },
      onNotice: (m) => notices.push(m),
    });

    expect(outcome.status).toBe("spawned");
    expect(spend.reserved).toHaveLength(1);
    expect(spend.reserved[0]?.usd).toBe(0.01);
    if (outcome.status === "spawned") {
      expect(outcome.reservationId).toBe("res-1");
      expect(outcome.pid).toBe(4242);
    }
    expect(captured).toBeDefined();
    expect(captured?.v).toBe(1);
    expect(captured?.kind).toBe("review-fork-worker-job");
    expect(captured?.reservationId).toBe("res-1");
    expect(captured?.spec.origin).toBe("review-fork");
    // The job was persisted as NDJSON under state and decodes back losslessly.
    const decoded = decodeReviewForkWorkerJob(readFileSync(capturedPath, "utf8"));
    expect(decoded?.jobId).toBe(captured?.jobId);
    expect(decoded?.reservationId).toBe("res-1");
    expect(notices.some((m) => m.includes("4242"))).toBe(true);
  });

  test("a spend refusal returns before spawning", async () => {
    const spend = fakeSpend({ failReserve: true });
    let spawned = false;
    const outcome = await spawnDetachedReviewFork({
      spec: makeSpec(),
      model: "mock-1",
      providerName: "mock",
      workspace: WORKSPACE,
      stateDir: STATE,
      spend,
      spawnWorker: () => {
        spawned = true;
        return {};
      },
    });
    expect(outcome.status).toBe("refused");
    expect(spawned).toBe(false);
  });


  test("admits fs.write on journal then job file before persist (rulings 589/611)", async () => {
    const spend = fakeSpend();
    const notices: string[] = [];
    const denyState = tempDir("hz-rfw-deny-state-");
    const denyWs = tempDir("hz-rfw-deny-ws-");
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(denyState, "no-such-hz-kernel");
    try {
      const kernelState = path.join(denyState, ".hzcode", "kernel");
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-rfj" }]),
        "utf8",
      );
      const outcome = await spawnDetachedReviewFork({
        spec: buildReviewFork({
          parentPrefix: parentPrefixRecord(PREFIX),
          transcript: [{ id: "msg_1", type: "user", summary: "review this" }],
          workspace: denyWs,
          stateDir: denyState,
        }),
        model: "mock-1",
        providerName: "mock",
        workspace: denyWs,
        stateDir: denyState,
        spend,
        reserveUsd: 0.01,
        spawnWorker: () => ({ pid: 1 }),
        onNotice: (m) => notices.push(m),
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.reason).toBe("guard-refused");
        expect(outcome.detail ?? "").toMatch(/denied|test-deny-rfj|journal|job/i);
      }
      expect(spend.released.length).toBeGreaterThan(0);
      expect(notices.some((m) => /journal refused|job file refused/i.test(m))).toBe(true);
      expect(existsSync(path.join(denyState, "review-fork-journal", "journal.jsonl"))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);

  test("a spawn failure releases the parent reservation", async () => {
    const spend = fakeSpend();
    const outcome = await spawnDetachedReviewFork({
      spec: makeSpec(),
      model: "mock-1",
      providerName: "mock",
      workspace: WORKSPACE,
      stateDir: STATE,
      spend,
      spawnWorker: () => {
        throw new Error("spawn exploded");
      },
    });
    expect(outcome.status).toBe("refused");
    expect(spend.released).toEqual(["res-1"]);
  });
});

describe("G-1 runReviewForkWorker (child side, scripted provider)", () => {
  test("settles the parent's reservation and never re-reserves", async () => {
    const spend = fakeSpend();
    const job: ReviewForkWorkerJob = {
      v: 1,
      kind: "review-fork-worker-job",
      jobId: "rfj-test",
      spec: makeSpec(),
      model: "mock-1",
      providerName: "mock",
      workspace: WORKSPACE,
      stateDir: STATE,
      reserveUsd: 0.01,
      reservationId: "res-parent",
    };
    const provider = createScriptedProvider([
      textTurn(
        JSON.stringify([
          { kind: "memory", title: "T", body: "B", evidence: ["msg_1"], reads: [] },
        ]),
      ),
    ]);
    const result = await runReviewForkWorker(job, { provider, spend });
    expect(result.status).toBe("ok");
    expect(spend.reserved).toHaveLength(0); // the worker never reserves again
    expect(spend.settled).toContain("res-parent");
  });

  test("rejects a malformed job file", () => {
    expect(decodeReviewForkWorkerJob("not json")).toBeUndefined();
    expect(decodeReviewForkWorkerJob(JSON.stringify({ v: 2, kind: "review-fork-worker-job" }))).toBeUndefined();
  });
});

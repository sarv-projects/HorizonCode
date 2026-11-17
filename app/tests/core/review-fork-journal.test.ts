/**
 * G-1 crash-durable fork settlement (rulings 488/522 residual).
 *
 * Hermetic: fake spend for the unit tests; a real file-backed SpendLedger for
 * the two end-to-end integration tests (still no provider/network — the worker
 * is driven through its injectable seams and a scripted provider). Proves the
 * reserve→settle journal transitions, crash recoverability, replay idempotency,
 * fail-closed corruption handling, owner-only permissions and exactly-once
 * settlement (no duplicate settle, no double charge).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  REVIEW_FORK_JOURNAL_FILE,
  ReviewForkJournalError,
  closeReviewForkJob,
  openReviewForkJob,
  readJournal,
  recoverReviewForkJournal,
  reviewForkJobId,
  reviewForkJournalPath,
  type JournalSpend,
  type ReviewForkJobContent,
} from "../../src/core/review-fork-journal";
import {
  buildReviewFork,
  parentPrefixRecord,
  runReviewForkWorker,
  spawnDetachedReviewFork,
  type ReviewForkWorkerJob,
} from "../../src/core/review";
import { SpendLedger } from "../../src/core/spend-ledger";
import { workspaceStateDir } from "../../src/core/paths";
import { createScriptedProvider, textTurn } from "../../src/core/providers/scripted";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const NOW = () => "2026-01-01T00:00:00.000Z";
const PREFIX = "SYSTEM: horizoncode v0.1\nTOOLS: [read,grep,glob]\n";

function content(reservationId = "res-1"): ReviewForkJobContent {
  return {
    reservationId,
    workspace: "/ws",
    stateDir: "/ws/.hz/state",
    model: "mock-1",
    providerName: "mock",
    reserveUsd: 0.01,
    systemPrefixSha256: "abc123",
  };
}

/** Fake spend that mimics SpendLedger: settling an unknown/already-settled id throws. */
function fakeSpend(): JournalSpend & { settled: Array<{ id: string; usd: number; note?: string }> } {
  const settled: Array<{ id: string; usd: number; note?: string }> = [];
  return {
    settled,
    settle(id, usd, note) {
      if (settled.some((s) => s.id === id)) throw new Error("spend: unknown-reservation");
      settled.push({ id, usd, note });
      return {};
    },
    release() {
      return {};
    },
  };
}

describe("G-1 durable journal — transitions", () => {
  test("reserve → settle records both transitions and recovery is a no-op", () => {
    const state = tempDir("hz-rfj-flow-");
    const ref = openReviewForkJob(state, content(), NOW);
    // The id is content-addressed: same content -> same id, no randomness.
    expect(ref.jobId).toBe(reviewForkJobId(content()));
    expect(ref.jobId.startsWith("rfj-")).toBe(true);
    closeReviewForkJob(state, ref, { kind: "settled", actualUsd: 0.008 }, NOW);

    const events = readJournal(state);
    expect(events.map((e) => e.transition)).toEqual(["reserved", "settled"]);
    expect(events[0]?.reservationId).toBe("res-1");
    expect(events[1]?.actualUsd).toBe(0.008);

    const spend = fakeSpend();
    const res = recoverReviewForkJournal(state, spend);
    expect(res.recovered).toBe(0);
    expect(res.skipped).toBe(1);
    expect(spend.settled).toHaveLength(0); // worker already settled it
  });

  test("a failed spawn records the failed transition", () => {
    const state = tempDir("hz-rfj-fail-");
    const ref = openReviewForkJob(state, content(), NOW);
    closeReviewForkJob(state, ref, { kind: "failed", reason: "spawn exploded" }, NOW);
    expect(readJournal(state).map((e) => e.transition)).toEqual(["reserved", "failed"]);
    expect(readJournal(state)[1]?.reason).toBe("spawn exploded");
  });
});

describe("G-1 recovery — crash, replay, fail-closed, permissions", () => {
  test("a crash (reserved only) leaves the reservation recoverable", () => {
    const state = tempDir("hz-rfj-crash-");
    openReviewForkJob(state, content(), NOW); // no settle row: worker crashed
    const spend = fakeSpend();
    const res = recoverReviewForkJournal(state, spend);
    expect(res.recovered).toBe(1);
    expect(spend.settled).toHaveLength(1);
    expect(spend.settled[0]?.id).toBe("res-1");
    expect(spend.settled[0]?.usd).toBe(0.01); // conservative reserved amount
    expect(spend.settled[0]?.note).toContain("recovery");
    const events = readJournal(state);
    expect(events.map((e) => e.transition)).toEqual(["reserved", "settled"]);
    expect(events[1]?.note).toContain("no live-provider cost capture");
  });

  test("replay is idempotent: recovering twice never settles twice", () => {
    const state = tempDir("hz-rfj-replay-");
    openReviewForkJob(state, content(), NOW);
    const spend = fakeSpend();
    const first = recoverReviewForkJournal(state, spend);
    const second = recoverReviewForkJournal(state, spend);
    const third = recoverReviewForkJournal(state, spend);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(third.recovered).toBe(0);
    expect(spend.settled).toHaveLength(1);
    expect(readJournal(state).filter((e) => e.transition === "settled")).toHaveLength(1);
  });

  test("a corrupt journal fails closed — no settlement is attempted", () => {
    const state = tempDir("hz-rfj-corrupt-");
    openReviewForkJob(state, content(), NOW);
    appendFileSync(reviewForkJournalPath(state), "{ this is not JSON\n", { mode: 0o600 });
    const spend = fakeSpend();
    expect(() => recoverReviewForkJournal(state, spend)).toThrow(ReviewForkJournalError);
    expect(spend.settled).toHaveLength(0); // fail closed, not "treat as empty"

    // A schema-valid JSON line with a wrong shape also fails closed.
    const state2 = tempDir("hz-rfj-corrupt2-");
    openReviewForkJob(state2, content(), NOW);
    appendFileSync(reviewForkJournalPath(state2), `${JSON.stringify({ v: 1, jobId: "x" })}\n`, { mode: 0o600 });
    expect(() => recoverReviewForkJournal(state2, fakeSpend())).toThrow(ReviewForkJournalError);
  });

  test("journal directory is 0700 and file is 0600", () => {
    const state = tempDir("hz-rfj-perms-");
    openReviewForkJob(state, content(), NOW);
    const file = reviewForkJournalPath(state);
    expect(path.basename(file)).toBe(REVIEW_FORK_JOURNAL_FILE);
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test("a missing journal is a healthy empty result", () => {
    const state = tempDir("hz-rfj-empty-");
    expect(readJournal(state)).toEqual([]);
    const res = recoverReviewForkJournal(state, fakeSpend());
    expect(res).toEqual({ recovered: 0, skipped: 0, failed: 0, jobIds: [] });
  });
});

function makeSpec(workspace: string) {
  return buildReviewFork({
    parentPrefix: parentPrefixRecord(PREFIX),
    transcript: [{ id: "msg_1", type: "user", summary: "review this" }],
    workspace,
    stateDir: workspaceStateDir(workspace),
  });
}

describe("G-1 end-to-end (real SpendLedger)", () => {
  test("normal worker settle leaves nothing for recovery — no duplicate settlement", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rfj-e2e-ok-"));
    try {
      const state = workspaceStateDir(ws);
      const ledger = new SpendLedger(ws, { limitMicroUsd: 100_000 }); // $0.10
      let captured: ReviewForkWorkerJob | undefined;
      const outcome = spawnDetachedReviewFork({
        spec: makeSpec(ws),
        model: "mock-1",
        providerName: "mock",
        workspace: ws,
        stateDir: state,
        spend: ledger,
        reserveUsd: 0.01,
        spawnWorker: (job) => {
          captured = job;
          return { pid: 1 };
        },
      });
      expect(outcome.status).toBe("spawned");
      expect(ledger.status().reservations).toBe(1);

      // Drive the worker completion through its injected seams (no network).
      const provider = createScriptedProvider([
        textTurn(JSON.stringify([{ kind: "memory", title: "T", body: "B", evidence: ["msg_1"], reads: [] }])),
      ]);
      await runReviewForkWorker(captured as ReviewForkWorkerJob, { provider, spend: ledger });
      expect(readJournal(state).map((e) => e.transition)).toEqual(["reserved", "settled"]);

      // Recovery is a no-op: the worker already settled; no double charge.
      const res = recoverReviewForkJournal(state, ledger);
      expect(res.recovered).toBe(0);
      expect(ledger.status().reservations).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("worker crash recovers the real reservation exactly once", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rfj-e2e-crash-"));
    try {
      const state = workspaceStateDir(ws);
      const ledger = new SpendLedger(ws, { limitMicroUsd: 100_000 });
      const outcome = spawnDetachedReviewFork({
        spec: makeSpec(ws),
        model: "mock-1",
        providerName: "mock",
        workspace: ws,
        stateDir: state,
        spend: ledger,
        reserveUsd: 0.01,
        spawnWorker: () => ({ pid: 1 }), // worker never completes
      });
      expect(outcome.status).toBe("spawned");
      expect(ledger.status().reservedUsd).toBeCloseTo(0.01);

      const res = recoverReviewForkJournal(state, ledger);
      expect(res.recovered).toBe(1);
      expect(ledger.status().reservations).toBe(0);
      expect(ledger.status().spentUsd).toBeCloseTo(0.01); // charged reserved amount

      // Replay does not charge again.
      const replay = recoverReviewForkJournal(state, ledger);
      expect(replay.recovered).toBe(0);
      expect(ledger.status().spentUsd).toBeCloseTo(0.01);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

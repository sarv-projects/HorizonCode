import { describe, expect, test } from "bun:test";
import {
  assertEvalApprovalFresh,
  assertEvalFrozenSplit,
  assertHeldOutLeakage,
  buildEvalApproval,
  buildFrozenSplit,
  casesContentHash,
  evalTraceCaseId,
  frozenSplitHash,
  appendRatchetDecision,
  assertRatchetDecisionsOnSplit,
  buildRatchetDecisionRecord,
  decideRatchetRound,
  loadRatchetDecisions,
  RatchetError,
  splitScoresFromResults,
} from "../../src/core/eval-approval";
import type { PostmortemEvalCase } from "../../src/core/evals";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CASES: PostmortemEvalCase[] = [
  {
    id: "b",
    from: "test",
    task: "do B",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
  {
    id: "a",
    from: "test",
    task: "do A",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
  {
    id: "c",
    from: "test",
    task: "do C",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
  {
    id: "d",
    from: "test",
    task: "do D",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
];

describe("eval approval freshness", () => {
  test("casesContentHash is order-independent by id", () => {
    const h1 = casesContentHash(CASES);
    const h2 = casesContentHash([...CASES].reverse());
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test("stale approval refuses", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-appr-"));
    const file = path.join(dir, "approval.json");
    const approval = buildEvalApproval(CASES);
    writeFileSync(file, JSON.stringify(approval));
    assertEvalApprovalFresh(CASES, file);
    const mutated = [...CASES, { ...CASES[0]!, id: "e", task: "new" }];
    expect(() => assertEvalApprovalFresh(mutated, file)).toThrow(/stale/);
  });
});

describe("eval frozen split (G-8)", () => {
  test("buildFrozenSplit is deterministic for a seed and partitions all ids", () => {
    const ids = CASES.map((c) => c.id);
    const s1 = buildFrozenSplit(ids, { heldOutFraction: 0.4, splitSeed: 7 });
    const s2 = buildFrozenSplit(ids, { heldOutFraction: 0.4, splitSeed: 7 });
    expect(s1).toEqual(s2);
    expect(s1.trainIds.length + s1.heldOutIds.length).toBe(ids.length);
    expect(s1.trainIds.length).toBeGreaterThan(0);
    expect(s1.heldOutIds.length).toBeGreaterThan(0);
    expect(s1.splitHash).toBe(frozenSplitHash(s1.trainIds, s1.heldOutIds));
    assertEvalFrozenSplit(CASES, s1);
  });

  test("different seeds yield different partitions (when possible)", () => {
    const ids = CASES.map((c) => c.id);
    const a = buildFrozenSplit(ids, { heldOutFraction: 0.5, splitSeed: 1 });
    const b = buildFrozenSplit(ids, { heldOutFraction: 0.5, splitSeed: 99 });
    expect(a.splitHash).not.toBe(b.splitHash);
  });

  test("assertEvalFrozenSplit refuses id drift and overlap", () => {
    const split = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 3 },
    );
    const drifted = CASES.filter((c) => c.id !== "a");
    expect(() => assertEvalFrozenSplit(drifted, split)).toThrow(/stale/);
    const overlapped = {
      ...split,
      trainIds: [...split.trainIds, split.heldOutIds[0]!],
      splitHash: frozenSplitHash([...split.trainIds, split.heldOutIds[0]!], split.heldOutIds),
    };
    expect(() => assertEvalFrozenSplit(CASES, overlapped)).toThrow(/overlap/);
  });

  test("approval with frozenSplit refuses corrupt hash and case-set drift", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-split-"));
    const file = path.join(dir, "approval.json");
    const frozen = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 11 },
    );
    const approval = buildEvalApproval(CASES, "baseline", frozen);
    writeFileSync(file, JSON.stringify(approval));
    assertEvalApprovalFresh(CASES, file);

    // Same partition bytes but wrong splitHash → refuse (host integrity).
    const corruptHash = {
      ...approval,
      frozenSplit: { ...frozen, splitHash: "0".repeat(64) },
    };
    writeFileSync(file, JSON.stringify(corruptHash));
    expect(() => assertEvalApprovalFresh(CASES, file)).toThrow(/corrupt|splitHash/);

    // Move one held-out id into train without a re-approve rewrite of the lists → overlap/corrupt.
    const movedId = frozen.heldOutIds[0]!;
    const swapped = {
      ...approval,
      frozenSplit: {
        ...frozen,
        trainIds: [...frozen.trainIds, movedId],
        heldOutIds: frozen.heldOutIds.filter((id) => id !== movedId),
        // Keep the OLD hash so the host detects tampering.
      },
    };
    writeFileSync(file, JSON.stringify(swapped));
    expect(() => assertEvalApprovalFresh(CASES, file)).toThrow(/corrupt|splitHash|overlap|stale/);

    // Case-set growth with an otherwise-valid frozen split refuses (content hash + split).
    writeFileSync(file, JSON.stringify(approval));
    const withExtra = [...CASES, { ...CASES[0]!, id: "e", task: "extra" }];
    expect(() => assertEvalApprovalFresh(withExtra, file)).toThrow(/stale/);
  });

  test("approval frozenSplit refuses when a held-out id is removed from cases", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-split-miss-"));
    const file = path.join(dir, "approval.json");
    const frozen = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 5 },
    );
    writeFileSync(file, JSON.stringify(buildEvalApproval(CASES, undefined, frozen)));
    const withoutHeldOut = CASES.filter((c) => !frozen.heldOutIds.includes(c.id));
    // Content hash also changes; either stale message is fine.
    expect(() => assertEvalApprovalFresh(withoutHeldOut, file)).toThrow(/stale|frozen split/);
  });
});

describe("eval held-out leakage (G-8)", () => {
  test("evalTraceCaseId parses omp-style train transcript basenames", () => {
    expect(evalTraceCaseId("a_rep0.json")).toBe("a");
    expect(evalTraceCaseId("path/to/held_rep12.json")).toBe("held");
    expect(evalTraceCaseId("notes.txt")).toBeNull();
    expect(evalTraceCaseId("_rep0.json")).toBeNull();
  });

  test("assertHeldOutLeakage allows train-only case ids and traces", () => {
    const split = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 11 },
    );
    assertHeldOutLeakage(split, {
      trainCaseIds: split.trainIds,
      trainTraces: split.trainIds.map((id) => `${id}_rep0.json`),
    });
  });

  test("assertHeldOutLeakage refuses held-out case ids on the train side", () => {
    const split = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 11 },
    );
    const leaked = split.heldOutIds[0]!;
    expect(() =>
      assertHeldOutLeakage(split, {
        trainCaseIds: [...split.trainIds, leaked],
      }),
    ).toThrow(/held-out leakage.*train case ids/);
  });

  test("assertHeldOutLeakage refuses held-out traces on the train side", () => {
    const split = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 11 },
    );
    const leaked = split.heldOutIds[0]!;
    expect(() =>
      assertHeldOutLeakage(split, {
        trainCaseIds: split.trainIds,
        trainTraces: [`traces/${leaked}_rep0.json`, `${split.trainIds[0]!}_rep1.json`],
      }),
    ).toThrow(/held-out leakage.*train traces/);
  });

  test("assertHeldOutLeakage refuses corrupt splitHash before probing", () => {
    const split = buildFrozenSplit(
      CASES.map((c) => c.id),
      { heldOutFraction: 0.5, splitSeed: 2 },
    );
    expect(() =>
      assertHeldOutLeakage(
        { ...split, splitHash: "0".repeat(64) },
        { trainCaseIds: split.trainIds },
      ),
    ).toThrow(/corrupt|splitHash/);
  });
});

describe("ratchet keep/revert rounds (G-8)", () => {
  const heldOut = { passed: 2, total: 4 };

  test("keep: candidate held-out pass rate improves", () => {
    const d = decideRatchetRound({
      baselineHeldOut: heldOut,
      candidateHeldOut: { passed: 3, total: 4 },
    });
    expect(d.verdict).toBe("keep");
    expect(d.tieBreak).toBe(false);
    expect(d.reason).toMatch(/improved/);
    expect(d.candidateHeldOutRate).toBe(0.75);
  });

  test("revert: candidate held-out pass rate regresses", () => {
    const d = decideRatchetRound({
      baselineHeldOut: heldOut,
      candidateHeldOut: { passed: 1, total: 4 },
    });
    expect(d.verdict).toBe("revert");
    expect(d.tieBreak).toBe(false);
    expect(d.reason).toMatch(/regressed/);
  });

  test("tie: train pass rate is the documented tie-break", () => {
    const better = decideRatchetRound({
      baselineHeldOut: heldOut,
      candidateHeldOut: heldOut,
      baselineTrain: { passed: 2, total: 4 },
      candidateTrain: { passed: 3, total: 4 },
    });
    expect(better.verdict).toBe("keep");
    expect(better.tieBreak).toBe(true);
    expect(better.reason).toMatch(/train.*>=/);

    const worse = decideRatchetRound({
      baselineHeldOut: heldOut,
      candidateHeldOut: heldOut,
      baselineTrain: { passed: 3, total: 4 },
      candidateTrain: { passed: 2, total: 4 },
    });
    expect(worse.verdict).toBe("revert");
    expect(worse.tieBreak).toBe(true);
    expect(worse.reason).toMatch(/train.*</);
  });

  test("tie with no train metrics defaults to keep; rule can invert it", () => {
    const metrics = { baselineHeldOut: heldOut, candidateHeldOut: heldOut };
    expect(decideRatchetRound(metrics).verdict).toBe("keep");
    expect(decideRatchetRound(metrics, { keepOnTrainNotWorse: false }).verdict).toBe("revert");
  });

  test("rejects invalid metrics (no silent divide-by-zero)", () => {
    expect(() =>
      decideRatchetRound({ baselineHeldOut: heldOut, candidateHeldOut: { passed: 0, total: 0 } }),
    ).toThrow(RatchetError);
    expect(() =>
      decideRatchetRound({ baselineHeldOut: heldOut, candidateHeldOut: { passed: 5, total: 4 } }),
    ).toThrow(/invalid-metrics/);
  });

  test("splitScoresFromResults scores exactly the frozen split", () => {
    const split = buildFrozenSplit(CASES.map((c) => c.id), { heldOutFraction: 0.5, splitSeed: 3 });
    const baseline = CASES.map((c) => ({ id: c.id, passed: true }));
    const candidate = CASES.map((c) => ({ id: c.id, passed: split.trainIds.includes(c.id) }));
    const metrics = splitScoresFromResults(split, baseline, candidate);
    expect(metrics.baselineHeldOut).toEqual({ passed: split.heldOutIds.length, total: split.heldOutIds.length });
    expect(metrics.candidateHeldOut).toEqual({ passed: 0, total: split.heldOutIds.length });
    expect(metrics.candidateTrain?.passed).toBe(split.trainIds.length);
    expect(() => splitScoresFromResults(split, baseline.slice(1), candidate)).toThrow(/exactly the frozen split/);
  });

  test("append-only decision log: keep, revert, no-op and never overwrite a keep", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ratchet-log-"));
    const log = path.join(dir, "ratchet", "decisions.jsonl");
    const split = buildFrozenSplit(CASES.map((c) => c.id), { heldOutFraction: 0.5, splitSeed: 9 });
    const clock = { now: () => "2026-11-16T00:00:00Z" };
    const win = buildRatchetDecisionRecord(
      {
        round: 0,
        variantId: "v1",
        split,
        metrics: {
          baselineHeldOut: { passed: 1, total: 4 },
          candidateHeldOut: { passed: 3, total: 4 },
        },
      },
      clock,
    );
    expect(win.verdict).toBe("keep");
    expect(appendRatchetDecision(log, win).appended).toBe(true);

    // Identical record is an idempotent no-op; no second line is written.
    const again = appendRatchetDecision(log, win);
    expect(again.appended).toBe(false);
    expect(loadRatchetDecisions(log).records).toHaveLength(1);

    // A kept result is single-assignment: a later revert for the same key refuses.
    const flip = buildRatchetDecisionRecord(
      {
        round: 0,
        variantId: "v1",
        split,
        metrics: {
          baselineHeldOut: { passed: 3, total: 4 },
          candidateHeldOut: { passed: 1, total: 4 },
        },
      },
      clock,
    );
    expect(flip.verdict).toBe("revert");
    expect(() => appendRatchetDecision(log, flip)).toThrow(/kept-result-overwrite/);
    expect(loadRatchetDecisions(log).records).toHaveLength(1);
    assertRatchetDecisionsOnSplit(log, split);

    // A prior revert is not a kept result and may be re-decided/appended.
    const log2 = path.join(dir, "ratchet2", "decisions.jsonl");
    appendRatchetDecision(log2, flip);
    appendRatchetDecision(log2, win);
    expect(loadRatchetDecisions(log2).records.map((r) => r.verdict)).toEqual(["revert", "keep"]);
  });

  test("corrupt decision log fails closed on a tampered recordHash", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ratchet-corrupt-"));
    const log = path.join(dir, "decisions.jsonl");
    const split = buildFrozenSplit(CASES.map((c) => c.id), { heldOutFraction: 0.5, splitSeed: 4 });
    const record = buildRatchetDecisionRecord(
      {
        round: 1,
        variantId: "v2",
        split,
        metrics: {
          baselineHeldOut: { passed: 1, total: 4 },
          candidateHeldOut: { passed: 2, total: 4 },
        },
      },
      { now: () => "2026-11-16T00:00:00Z" },
    );
    appendRatchetDecision(log, record);
    writeFileSync(log, `${JSON.stringify({ ...record, verdict: "revert" })}\n`);
    expect(() => loadRatchetDecisions(log)).toThrow(/hash mismatch/);
  });
});

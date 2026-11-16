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

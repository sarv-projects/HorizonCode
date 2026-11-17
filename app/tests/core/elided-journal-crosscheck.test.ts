import { describe, expect, test } from "bun:test";
import type { CompactionRecordV1 } from "../../src/core/compaction-journal";
import { contextChunkRows } from "../../src/core/context-token-table";
import { crossCheckElidedJournal } from "../../src/core/elided-journal-crosscheck";

function record(sessionId: string, dropped: number, seq = 1): CompactionRecordV1 {
  return {
    v: 1,
    id: `c-${seq}`,
    seq,
    ts: "2026-11-17T00:00:00Z",
    sessionId,
    trigger: "history-window",
    tokensBefore: dropped + 100,
    tokensAfter: 100,
    dropped,
    kept: 100,
    window: 32_000,
    summaryDigest: "abc",
    strategySet: ["reduced"],
    prevHash: null,
    hash: "def",
  };
}

describe("I-2 elided-journal cross-check", () => {
  test("reconciles a summary against the durable dropped count", () => {
    const r = crossCheckElidedJournal(1000, [record("s1", 990)], { sessionId: "s1" });
    expect(r.reconciled).toBe(true);
    expect(r.journalDropped).toBe(990);
    expect(r.delta).toBe(10);
    expect(r.note).toContain("elided journal:");
  });

  test("sums several compactions and honours tolerance", () => {
    const r = crossCheckElidedJournal(2020, [record("s1", 1000, 1), record("s1", 1000, 2)], {
      sessionId: "s1",
      tolerance: 10,
      relativeTolerance: 0.01,
    });
    expect(r.entries).toBe(2);
    expect(r.reconciled).toBe(true);
  });

  test("mismatch and missing records fail closed", () => {
    const mismatch = crossCheckElidedJournal(5000, [record("s1", 100)], { sessionId: "s1" });
    expect(mismatch.reconciled).toBe(false);
    expect(mismatch.note).toContain("mismatch");
    const missing = crossCheckElidedJournal(500, [record("other", 500)], { sessionId: "s1" });
    expect(missing.reconciled).toBe(false);
    expect(missing.note).toContain("not reconciled");
  });

  test("context token table surfaces the cross-check on the compaction row", () => {
    const history = [{ role: "user" as const, content: `## Summary of elided turns (compacted)\nelided\n\n---\n\nreal` }];
    const baseline = contextChunkRows(history, "sys", undefined, "nvidia").find((r) => r.kind === "compaction");
    const dropped = baseline?.tokens ?? 0;
    const rows = contextChunkRows(history, "sys", undefined, "nvidia", [record("s1", dropped)], "s1");
    const compaction = rows.find((r) => r.kind === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction!.crossCheck?.reconciled).toBe(true);
    expect(compaction!.hint).toContain("elided journal:");
  });
});

/**
 * reverse-jsonl-scanner.test.ts — codex rollout ReverseJsonlScanner ADAPT.
 * Pure scan of an in-memory NDJSON blob from the end; bounded record size,
 * frozen-prefix end offset, invalid records rejected without aborting.
 */
import { describe, expect, test } from "bun:test";
import {
  scanReverseJsonl,
  type ScanOutcome,
} from "../../src/core/reverse-jsonl-scanner";

describe("reverse JSONL scanner (codex port)", () => {
  test("scans records newest-first, skipping blank lines", () => {
    const blob = '{"n":1}\n{"n":2}\n\n{"n":3}\n';
    const out = scanReverseJsonl(blob);
    expect(out.map((r) => (r as { value: { n: number } }).value.n)).toEqual([3, 2, 1]);
  });

  test("invalid JSON is Rejected; scanner still returns valid siblings", () => {
    const blob = '{"ok":1}\nnot json\n{"ok":3}\n';
    const out = scanReverseJsonl(blob);
    expect(out).toHaveLength(3);
    expect(out.filter((r) => r.kind === "parsed")).toHaveLength(2);
    expect(out.some((r) => r.kind === "rejected")).toBe(true);
  });

  test("end offset scans only a frozen prefix", () => {
    const blob = '{"n":1}\n{"n":2}\n{"n":3}\n';
    const end = blob.indexOf('{"n":3}'); // logical end at the newline after record 2
    const out = scanReverseJsonl(blob, { endByteOffset: end });
    expect(out.map((r) => (r as { value: { n: number } }).value.n)).toEqual([2, 1]);
  });

  test("oversized records are skipped, not parsed", () => {
    const blob = '{"n":1}\n' + '{"big":"' + "x".repeat(500) + '"}\n';
    const out = scanReverseJsonl(blob, { maxRecordBytes: 100 });
    expect(out).toHaveLength(1);
    expect((out[0] as { value: { n: number } }).value.n).toBe(1);
  });
});

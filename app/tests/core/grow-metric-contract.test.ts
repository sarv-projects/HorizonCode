/**
 * grow-metric-contract.test.ts — H-7 grow CLI summary contracts (ruling 555).
 */
import { describe, expect, test } from "bun:test";
import {
  growApplyPublication,
  growDreamPublication,
  growFromPostmortemsPublication,
  growListPublication,
} from "../../src/grow";
import { parsePublishedNumber } from "../../src/core/metrics";

describe("grow H-7 metric contracts (ruling 555)", () => {
  test("growListPublication contracts proposal status counts", () => {
    const blocks = growListPublication({
      proposals: 4,
      applied: 1,
      pending: 2,
      unknown: 1,
    });
    expect(blocks).toHaveLength(4);
    const byMetric = Object.fromEntries(
      blocks.map((b) => {
        const p = parsePublishedNumber(b);
        return [p.metric, p.value];
      }),
    );
    expect(Number(byMetric["grow list proposals"])).toBe(4);
    expect(Number(byMetric["grow list applied"])).toBe(1);
    expect(Number(byMetric["grow list pending"])).toBe(2);
    expect(Number(byMetric["grow list unknown"])).toBe(1);
  });

  test("growFromPostmortemsPublication contracts curation counts", () => {
    const blocks = growFromPostmortemsPublication({
      postmortems: 5,
      appended: 2,
      duplicates: 1,
      refused: 1,
      skipped: 1,
    });
    expect(blocks).toHaveLength(5);
    const values = blocks.map((b) => Number(parsePublishedNumber(b).value));
    expect(values).toEqual([5, 2, 1, 1, 1]);
  });

  test("growApplyPublication contracts dry-run / applied outcomes", () => {
    const dry = growApplyPublication({
      dryRun: true,
      applied: false,
      alreadyApplied: false,
      bytesWritten: 0,
    });
    expect(dry.map((b) => Number(parsePublishedNumber(b).value))).toEqual([1, 0, 0, 0]);
    const applied = growApplyPublication({
      dryRun: false,
      applied: true,
      alreadyApplied: false,
      bytesWritten: 42,
    });
    expect(applied.map((b) => Number(parsePublishedNumber(b).value))).toEqual([0, 1, 0, 42]);
  });

  test("growDreamPublication contracts plan + consolidation counts", () => {
    const off = growDreamPublication({
      factCount: 3,
      empty: false,
      consolidationEnabled: false,
      appended: 0,
      skippedDuplicate: 0,
      noop: true,
    });
    expect(off).toHaveLength(2);
    expect(Number(parsePublishedNumber(off[0]!).value)).toBe(3);
    const on = growDreamPublication({
      factCount: 0,
      empty: true,
      consolidationEnabled: true,
      appended: 2,
      skippedDuplicate: 1,
      noop: false,
    });
    expect(on).toHaveLength(5);
    expect(on.map((b) => Number(parsePublishedNumber(b).value))).toEqual([0, 1, 2, 1, 0]);
  });
});

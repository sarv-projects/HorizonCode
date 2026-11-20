import { describe, expect, test } from "bun:test";
import {
  formatNestedObserveSummary,
  nestedObserveBlocksVerify,
  type NestedObserveSessionSurface,
} from "../../src/core/effect-nested-observe";

describe("effect nested observe summary (ruling 697)", () => {
  test("format ok and refused summaries", () => {
    const okSurface: NestedObserveSessionSurface = {
      kind: "kernel",
      report: {
        ok: true,
        visited: 2,
        verified: 2,
        refused: 0,
        maxDepth: 4,
        scope: "childEffectIds_ownerlog_settlement_observe_only",
        residual: "not R172",
        nodes: [],
      },
    };
    expect(formatNestedObserveSummary(okSurface)).toContain("2/2 child effect(s)");

    const badSurface: NestedObserveSessionSurface = {
      kind: "kernel",
      report: {
        ok: false,
        visited: 1,
        verified: 0,
        refused: 1,
        maxDepth: 4,
        scope: "childEffectIds_ownerlog_settlement_observe_only",
        residual: "not R172",
        nodes: [
          { effectId: "missing-child", classification: "missing_in_ownerlog", ok: false },
        ],
      },
    };
    expect(formatNestedObserveSummary(badSurface)).toContain("missing_in_ownerlog");
    expect(nestedObserveBlocksVerify(badSurface)).toBe(true);
    expect(nestedObserveBlocksVerify(okSurface)).toBe(false);
  });

  test("skipped surface does not block verify", () => {
    const skipped: NestedObserveSessionSurface = { kind: "skipped", reason: "no kernel" };
    expect(formatNestedObserveSummary(skipped)).toContain("skipped");
    expect(nestedObserveBlocksVerify(skipped)).toBe(false);
  });
});
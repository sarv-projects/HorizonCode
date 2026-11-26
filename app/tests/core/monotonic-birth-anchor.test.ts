/**
 * monotonic-birth-anchor.test.ts -- D-3 sleep/wake re-anchor decision helper.
 * Pure: clocks and process facts are injected. Fail-closed on pid reuse.
 * No wiring into verifyIdentity here (a later slice adopts the verdict).
 */
import { describe, expect, test } from "bun:test";
import {
  reconcileBirthAnchor,
  type BirthAnchorState,
} from "../../src/core/monotonic-birth-anchor";

const RECORDED: BirthAnchorState = {
  bootId: "boot:abc",
  startTicks: 12_345,
  monotonicNs: 1_000_000_000n,
  wallAtRecordMs: 1_000_000,
};

describe("monotonic birth re-anchor", () => {
  test("consistent clocks with stable identity need no re-anchor", () => {
    const verdict = reconcileBirthAnchor({
      recorded: RECORDED,
      observedBootId: "boot:abc",
      observedStartTicks: 12_345,
      observedMonotonicNs: 1_500_000_000n,
      observedWallMs: 1_000_500, // +500 ms wall, +500 ms monotonic
    });
    expect(verdict).toBe("same-birth");
  });

  test("clock skew with stable boot id + startTicks re-anchors safely", () => {
    const verdict = reconcileBirthAnchor({
      recorded: RECORDED,
      observedBootId: "boot:abc",
      observedStartTicks: 12_345,
      observedMonotonicNs: 1_000_000_000n, // monotonic did not advance (VM suspend)
      observedWallMs: 1_360_000, // wall jumped 6 min (NTP step / wake)
    });
    expect(verdict).toBe("re-anchored");
  });

  test("a changed boot id is always refused", () => {
    const verdict = reconcileBirthAnchor({
      recorded: RECORDED,
      observedBootId: "boot:new",
      observedStartTicks: 12_345,
      observedMonotonicNs: 1_500_000_000n,
      observedWallMs: 1_000_500,
    });
    expect(verdict).toBe("refuse");
  });

  test("a changed startTicks (pid reuse) is always refused", () => {
    const verdict = reconcileBirthAnchor({
      recorded: RECORDED,
      observedBootId: "boot:abc",
      observedStartTicks: 99, // recycled pid — different birth
      observedMonotonicNs: 1_500_000_000n,
      observedWallMs: 1_000_500,
    });
    expect(verdict).toBe("refuse");
  });

  test("non-finite or negative readings fail closed", () => {
    const base = {
      recorded: RECORDED,
      observedBootId: "boot:abc",
      observedStartTicks: 12_345,
      observedMonotonicNs: 1_500_000_000n,
      observedWallMs: 1_000_500,
    };
    expect(reconcileBirthAnchor({ ...base, observedWallMs: Number.NaN })).toBe("refuse");
    expect(reconcileBirthAnchor({ ...base, observedStartTicks: -1 })).toBe("refuse");
    expect(reconcileBirthAnchor({ ...base, observedBootId: "" })).toBe("refuse");
    expect(
      reconcileBirthAnchor({ ...base, recorded: { ...RECORDED, startTicks: Number.NaN } }),
    ).toBe("refuse");
  });

  test("skew exactly at the tolerance boundary is still same-birth", () => {
    // tolerance default 2000 ms; wall +2000, monotonic +2000 -> 0 skew.
    const verdict = reconcileBirthAnchor({
      recorded: RECORDED,
      observedBootId: "boot:abc",
      observedStartTicks: 12_345,
      observedMonotonicNs: RECORDED.monotonicNs + 2_000_000_000n,
      observedWallMs: RECORDED.wallAtRecordMs + 2000,
      skewToleranceMs: 2000,
    });
    expect(verdict).toBe("same-birth");
  });
});

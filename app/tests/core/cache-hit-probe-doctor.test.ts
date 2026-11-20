import { describe, expect, test } from "bun:test";
import {
  assessCacheHitProbeDoctor,
  formatCacheHitProbeDoctorDetail,
} from "../../src/core/providers/cache-hit-probe-doctor";

describe("cache-hit probe doctor (B-4)", () => {
  test("hermetic self-check OK without live flag", () => {
    const posture = assessCacheHitProbeDoctor({ HZ_PROVIDER: "mock" }, "/tmp");
    expect(posture.selfCheck.ok).toBe(true);
    expect(posture.liveRequested).toBe(false);
    const detail = formatCacheHitProbeDoctorDetail(posture);
    expect(detail).toContain("hermetic parse/compare OK");
    expect(detail).toContain("live measure off");
    expect(detail).not.toMatch(/live hit observed/i);
  });

  test("HZ_LIVE_CACHE=1 without key warns via doctor posture", () => {
    const posture = assessCacheHitProbeDoctor(
      { HZ_PROVIDER: "anthropic", HZ_LIVE_CACHE: "1" },
      "/tmp",
    );
    expect(posture.liveRequested).toBe(true);
    expect(posture.providerKeyMissing).toBe(true);
    const detail = formatCacheHitProbeDoctorDetail(posture);
    expect(detail).toContain("no provider key");
    expect(detail).toContain("not claimed");
  });
});
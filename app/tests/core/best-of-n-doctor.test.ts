import { describe, expect, test } from "bun:test";
import { assessBestOfNDoctor, formatBestOfNDoctorDetail } from "../../src/core/best-of-n-doctor";

describe("best-of-n doctor", () => {
  test("default off", () => {
    const posture = assessBestOfNDoctor({});
    expect(posture.racingEnabled).toBe(false);
    expect(formatBestOfNDoctorDetail(posture)).toContain("racing off");
  });

  test("parallel on when env set", () => {
    const posture = assessBestOfNDoctor({ HZ_BEST_OF_N: "3", HZ_BEST_OF_N_PARALLEL: "1" });
    expect(posture.racingEnabled).toBe(true);
    expect(posture.parallel).toBe(true);
    expect(formatBestOfNDoctorDetail(posture)).toContain("parallel");
  });
});
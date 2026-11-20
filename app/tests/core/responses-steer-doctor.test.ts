import { describe, expect, test } from "bun:test";
import {
  assessResponsesSteerDoctor,
  formatResponsesSteerDoctorDetail,
} from "../../src/core/providers/responses-steer-doctor";

describe("responses steer doctor (C-9)", () => {
  test("hermetic self-check OK without product flag", () => {
    const posture = assessResponsesSteerDoctor({ HZ_PROVIDER: "mock" });
    expect(posture.selfCheck.ok).toBe(true);
    expect(posture.productRequested).toBe(false);
    const detail = formatResponsesSteerDoctorDetail(posture);
    expect(detail).toContain("hermetic wire protocol OK");
    expect(detail).toContain("product steer off");
    expect(detail).not.toMatch(/live GPT-6 steer observed/i);
  });

  test("HZ_RESPONSES_STEER=1 without key warns via doctor posture", () => {
    const posture = assessResponsesSteerDoctor({
      HZ_PROVIDER: "openai",
      HZ_RESPONSES_STEER: "1",
    });
    expect(posture.productRequested).toBe(true);
    expect(posture.openAiKeyMissing).toBe(true);
    const detail = formatResponsesSteerDoctorDetail(posture);
    expect(detail).toContain("OPENAI_API_KEY unset");
    expect(detail).toContain("not claimed");
  });
});
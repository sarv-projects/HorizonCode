import { describe, expect, test } from "bun:test";
import { checkSpeculativeExecution, doctorFixSuggestion, type DoctorEnv } from "../../src/core/doctor";
import { hermeticSpeculationDoctorSelfCheck } from "../../src/core/speculation-doctor";

function fakeEnv(overrides: Record<string, string> = {}): DoctorEnv {
  return {
    env: { HOME: "/tmp", ...overrides },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    workspace: "/tmp/ws",
    home: "/tmp",
  };
}

describe("speculation doctor", () => {
  test("hermetic self-check passes", () => {
    const self = hermeticSpeculationDoctorSelfCheck();
    expect(self.ok).toBe(true);
  });

  test("OK when default-off", () => {
    const line = checkSpeculativeExecution(fakeEnv());
    expect(line.id).toBe("runtime.speculation");
    expect(line.status).toBe("ok");
    expect(line.detail).toMatch(/default-off/i);
  });

  test("WARN when HZ_SPECULATIVE_EXECUTION=1", () => {
    const line = checkSpeculativeExecution(fakeEnv({ HZ_SPECULATIVE_EXECUTION: "1" }));
    expect(line.status).toBe("warn");
    expect(line.detail).toMatch(/fingerprint mismatch/i);
  });

  test("doctor fix lines export opt-in hint", () => {
    const lines = doctorFixSuggestion("runtime.speculation", {});
    expect(lines?.some((l) => l.includes("HZ_SPECULATIVE_EXECUTION=1"))).toBe(true);
  });
});
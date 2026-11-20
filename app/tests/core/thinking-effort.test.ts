import { describe, expect, test } from "bun:test";
import {
  autoThinkingCeiling,
  capAtAutoThinkingCeiling,
  parseThinkingAutoFlag,
  resolveThinkingEffort,
  ultrathinkInText,
} from "../../src/core/thinking-effort";

describe("thinking-effort C-11", () => {
  test("ultrathink forces xhigh", () => {
    expect(ultrathinkInText("please ultrathink this")).toBe(true);
    expect(resolveThinkingEffort({ userText: "ultrathink now" }).effort).toBe("xhigh");
  });

  test("env default when no keyword", () => {
    const r = resolveThinkingEffort({ userText: "hello", envValue: "medium" });
    expect(r.effort).toBe("medium");
    expect(r.source).toBe("env");
  });

  test("ultrathink beats env", () => {
    const r = resolveThinkingEffort({ userText: "ultrathink", envValue: "low" });
    expect(r.effort).toBe("xhigh");
    expect(r.source).toBe("ultrathink");
  });

  test("auto ceiling is one tier below max", () => {
    expect(autoThinkingCeiling()).toBe("high");
    expect(capAtAutoThinkingCeiling("xhigh")).toBe("high");
    expect(capAtAutoThinkingCeiling("high")).toBe("high");
    expect(capAtAutoThinkingCeiling("low")).toBe("low");
  });

  test("effort unset defaults to cheap heuristic auto (≤ ceiling)", () => {
    const r = resolveThinkingEffort({ userText: "rename a typo" });
    expect(r.source).toBe("auto");
    expect(r.effort).toBeDefined();
    expect(r.effort).not.toBe("xhigh");
    const hard = resolveThinkingEffort({
      userText: "refactor concurrent security architecture performance ".repeat(40),
    });
    expect(hard.source).toBe("auto");
    expect(hard.effort).toBe("high");
  });

  test("HZ_THINKING_AUTO=0 opts out when effort unset", () => {
    expect(parseThinkingAutoFlag("0")).toBe(false);
    expect(parseThinkingAutoFlag(undefined)).toBe(true);
    const r = resolveThinkingEffort({ userText: "hello", autoDifficulty: false });
    expect(r.effort).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  test("env beats default-on auto", () => {
    const r = resolveThinkingEffort({ userText: "refactor everything", envValue: "minimal" });
    expect(r.effort).toBe("minimal");
    expect(r.source).toBe("env");
  });

  test("HZ_THINKING_CALIBRATED=1 routes auto via calibrated local estimate (ruling 541)", () => {
    const legacy = resolveThinkingEffort({ userText: "do the task", calibratedDifficulty: false });
    expect(legacy.source).toBe("auto");

    const calibrated = resolveThinkingEffort({
      userText: "do the task",
      calibratedDifficulty: true,
      calibrationFeatures: { toolCount: 12, priorStepOutcomes: ["failure", "failure"] },
    });
    expect(calibrated.source).toBe("auto-calibrated");
    expect(calibrated.effort).toBeDefined();
    expect(calibrated.effort).not.toBe("xhigh");
    // Prior failures + tools push calibrated difficulty above the cheap heuristic.
    expect(["medium", "high"]).toContain(calibrated.effort);

    const fromEnvFlag = resolveThinkingEffort({
      userText: "rename a typo",
      calibratedEnv: { HZ_THINKING_CALIBRATED: "1" },
    });
    expect(fromEnvFlag.source).toBe("auto-calibrated");
    expect(fromEnvFlag.effort).not.toBe("xhigh");

    // Explicit env effort still wins over calibrated auto.
    const envWins = resolveThinkingEffort({
      userText: "refactor everything",
      envValue: "minimal",
      calibratedDifficulty: true,
    });
    expect(envWins).toEqual({ effort: "minimal", source: "env" });
  });
});

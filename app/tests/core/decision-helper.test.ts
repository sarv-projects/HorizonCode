import { describe, expect, test } from "bun:test";
import {
  CALIBRATED_DIFFICULTY_OPT_IN_ENV,
  LOCAL_CALIBRATION_PRIORS,
  autoThinkingEffortCalibrated,
  autoThinkingEffortFromText,
  calibratedDifficultyOptIn,
  chooseThinkingEffort,
  resolveDifficultyScore,
  scoreTaskDifficulty,
  scoreTaskDifficultyCalibrated,
} from "../../src/core/decision-helper";
import { resolveThinkingEffort } from "../../src/core/thinking-effort";

describe("decision helper + C-11 auto", () => {
  test("hard prompt scores higher", () => {
    const easy = scoreTaskDifficulty("fix typo");
    const hard = scoreTaskDifficulty("refactor concurrent security architecture".repeat(20));
    expect(hard.value).toBeGreaterThan(easy.value);
  });

  test("chooseThinkingEffort never picks above auto ceiling", () => {
    const choice = chooseThinkingEffort({ value: 1, reasons: ["forced"] });
    expect(choice.pick).toBe("high");
  });

  test("default-on auto via resolveThinkingEffort when effort unset", () => {
    const r = resolveThinkingEffort({ userText: "rename variable" });
    expect(r.source).toBe("auto");
    expect(r.effort).toBeDefined();
    expect(r.effort).not.toBe("xhigh");
    const auto = autoThinkingEffortFromText("ultrathink is explicit elsewhere");
    expect(auto.pick).toBeDefined();
    expect(auto.pick).not.toBe("xhigh");
  });
});

describe("C-11 local calibration (ruling 493, opt-in, no provider call)", () => {
  test("cheap heuristic is unchanged (byte-identical scores)", () => {
    // Pin the legacy values so the local path cannot silently alter routing.
    const easy = scoreTaskDifficulty("fix typo");
    expect(easy.value).toBeCloseTo(0.13, 10);
    expect(easy.reasons).toEqual(["short_prompt", "easy:\\btypo\\b"]);
    const long = scoreTaskDifficulty("x".repeat(1300));
    expect(long.value).toBeCloseTo(0.6, 10);
    expect(long.reasons).toEqual(["long_prompt"]);
    const hard = scoreTaskDifficulty("concurrent refactor");
    expect(hard.value).toBeCloseTo(0.4, 10);
    expect(hard.reasons).toEqual(["short_prompt", "hard:\\brefactor\\b"]);
  });

  test("calibrated probability is deterministic and bounded [0,1]", () => {
    const a = scoreTaskDifficultyCalibrated({ userText: "build a parser", toolCount: 3 });
    const b = scoreTaskDifficultyCalibrated({ userText: "build a parser", toolCount: 3 });
    expect(a).toEqual(b);
    expect(a.probability).toBeGreaterThanOrEqual(0);
    expect(a.probability).toBeLessThanOrEqual(1);
    expect(a.value).toBe(a.probability);
    expect(Number.isFinite(a.logOdds)).toBe(true);
    expect(a.reasons).toContain("prior:base");
    expect(a.usedFeatures.toolCount).toBe(3);
  });

  test("documented prior table drives monotone feature effects", () => {
    const base = scoreTaskDifficultyCalibrated({ userText: "do the task" });
    const moreTools = scoreTaskDifficultyCalibrated({ userText: "do the task", toolCount: 8 });
    const failures = scoreTaskDifficultyCalibrated({
      userText: "do the task",
      priorStepOutcomes: ["failure", "failure", "success"],
    });
    const successes = scoreTaskDifficultyCalibrated({
      userText: "do the task",
      priorStepOutcomes: ["success", "success"],
    });
    expect(moreTools.probability).toBeGreaterThan(base.probability);
    expect(failures.probability).toBeGreaterThan(base.probability);
    expect(successes.probability).toBeLessThan(base.probability);
    expect(LOCAL_CALIBRATION_PRIORS.perToolLogOdds).toBeGreaterThan(0);
    expect(LOCAL_CALIBRATION_PRIORS.priorFailureLogOdds).toBeGreaterThan(0);
    expect(LOCAL_CALIBRATION_PRIORS.priorSuccessLogOdds).toBeLessThan(0);
  });

  test("feature values are clamped so numeric garbage cannot skew the estimate", () => {
    const sane = scoreTaskDifficultyCalibrated({ toolCount: 5, priorStepOutcomes: ["failure", "failure", "failure"] });
    const huge = scoreTaskDifficultyCalibrated({
      toolCount: 500,
      priorStepOutcomes: Array(500).fill("failure"),
    });
    expect(huge.usedFeatures.toolCount).toBe(LOCAL_CALIBRATION_PRIORS.toolCountCap);
    expect(huge.usedFeatures.priorFailures).toBe(LOCAL_CALIBRATION_PRIORS.priorOutcomeCap);
    expect(huge.probability).toBeLessThanOrEqual(1);
    // Non-finite numeric garbage is treated as absent (fail closed to 0).
    expect(scoreTaskDifficultyCalibrated({ toolCount: Number.POSITIVE_INFINITY }).usedFeatures.toolCount).toBe(0);
    expect(sane.usedFeatures.priorFailures).toBe(3);
  });

  test("opt-in selector: default stays legacy, calibrated only when asked", () => {
    const features = { userText: "fix typo", toolCount: 4 };
    const legacy = resolveDifficultyScore(features, { calibrated: false });
    expect(legacy).toEqual(scoreTaskDifficulty("fix typo"));
    const calibrated = resolveDifficultyScore(features, { calibrated: true });
    expect(calibrated).toEqual(scoreTaskDifficultyCalibrated(features));
  });

  test("opt-in env var name + parsing (no HZ_THINKING_EFFORT read)", () => {
    expect(CALIBRATED_DIFFICULTY_OPT_IN_ENV).toBe("HZ_THINKING_CALIBRATED");
    expect(calibratedDifficultyOptIn({ HZ_THINKING_CALIBRATED: "1" })).toBe(true);
    expect(calibratedDifficultyOptIn({ HZ_THINKING_CALIBRATED: "TRUE" })).toBe(true);
    expect(calibratedDifficultyOptIn({ HZ_THINKING_CALIBRATED: "0" })).toBe(false);
    expect(calibratedDifficultyOptIn({ HZ_THINKING_EFFORT: "high" })).toBe(false);
    expect(resolveDifficultyScore({ userText: "x" }, { env: { HZ_THINKING_CALIBRATED: "yes" } })).toEqual(
      scoreTaskDifficultyCalibrated({ userText: "x" }),
    );
  });

  test("calibrated estimate still maps through the existing auto ceiling", () => {
    const pick = autoThinkingEffortCalibrated({ userText: "huge", toolCount: 50, priorStepOutcomes: ["failure"] });
    expect(pick.pick).toBeDefined();
    expect(pick.pick).not.toBe("xhigh");
  });
});

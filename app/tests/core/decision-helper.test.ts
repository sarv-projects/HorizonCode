import { describe, expect, test } from "bun:test";
import {
  autoThinkingEffortFromText,
  chooseThinkingEffort,
  scoreTaskDifficulty,
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

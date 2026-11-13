import { describe, expect, test } from "bun:test";
import { autoThinkingEffortFromText, scoreTaskDifficulty } from "../../src/core/decision-helper";
import { resolveThinkingEffort } from "../../src/core/thinking-effort";

describe("decision helper + C-11 auto", () => {
  test("hard prompt scores higher", () => {
    const easy = scoreTaskDifficulty("fix typo");
    const hard = scoreTaskDifficulty("refactor concurrent security architecture".repeat(20));
    expect(hard.value).toBeGreaterThan(easy.value);
  });

  test("HZ_THINKING_AUTO via resolveThinkingEffort", () => {
    const r = resolveThinkingEffort({ userText: "rename variable", autoDifficulty: true });
    expect(r.source).toBe("auto");
    expect(r.effort).toBeDefined();
    const auto = autoThinkingEffortFromText("ultrathink is explicit elsewhere");
    expect(auto.pick).toBeDefined();
  });
});

/** C-11 live difficulty judge (ruling 694). */

import { afterEach, describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "../../src/contracts";
import {
  LIVE_DIFFICULTY_JUDGE_ENV,
  buildDifficultyJudgePrompt,
  liveDifficultyJudgeOptIn,
  parseDifficultyJudgeTier,
  resolveThinkingEffortWithLiveJudge,
} from "../../src/core/difficulty-live-judge";

afterEach(() => {
  delete process.env[LIVE_DIFFICULTY_JUDGE_ENV];
});

describe("difficulty live judge (ruling 694)", () => {
  test("liveDifficultyJudgeOptIn reads HZ_THINKING_LIVE_JUDGE", () => {
    expect(liveDifficultyJudgeOptIn({})).toBe(false);
    expect(liveDifficultyJudgeOptIn({ [LIVE_DIFFICULTY_JUDGE_ENV]: "1" })).toBe(true);
    expect(liveDifficultyJudgeOptIn({ [LIVE_DIFFICULTY_JUDGE_ENV]: "yes" })).toBe(true);
    expect(liveDifficultyJudgeOptIn({ [LIVE_DIFFICULTY_JUDGE_ENV]: "0" })).toBe(false);
  });

  test("parseDifficultyJudgeTier accepts capped rungs and rejects xhigh", () => {
    expect(parseDifficultyJudgeTier("medium")).toBe("medium");
    expect(parseDifficultyJudgeTier("HIGH please")).toBe("high");
    expect(parseDifficultyJudgeTier("xhigh")).toBeUndefined();
    expect(parseDifficultyJudgeTier("")).toBeUndefined();
  });

  test("buildDifficultyJudgePrompt bounds the user text", () => {
    const p = buildDifficultyJudgePrompt("x".repeat(5_000), { toolCount: 2, priorStepOutcomes: ["failure"] });
    expect(p).toContain("medium");
    expect(p).toContain("Prior tool failures in session: 1");
    expect(p).toContain("…(truncated)");
  });

  test("resolveThinkingEffortWithLiveJudge uses provider tier when opted in", async () => {
    process.env[LIVE_DIFFICULTY_JUDGE_ENV] = "1";
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "high" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const resolved = await resolveThinkingEffortWithLiveJudge({
      userText: "please refactor the auth module carefully",
      provider,
      mainModel: "gpt-test",
      env: { [LIVE_DIFFICULTY_JUDGE_ENV]: "1" },
    });
    expect(resolved.source).toBe("auto-live-judge");
    expect(resolved.effort).toBe("high");
  });

  test("resolveThinkingEffortWithLiveJudge fails closed to local auto on bad reply", async () => {
    process.env[LIVE_DIFFICULTY_JUDGE_ENV] = "1";
    const provider: Provider = {
      name: "scripted",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "not-a-tier" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const resolved = await resolveThinkingEffortWithLiveJudge({
      userText: "hi",
      provider,
      mainModel: "gpt-test",
      env: { [LIVE_DIFFICULTY_JUDGE_ENV]: "1", HZ_THINKING_AUTO: "1" },
    });
    expect(resolved.source).not.toBe("auto-live-judge");
    expect(resolved.effort).toBeDefined();
  });
});

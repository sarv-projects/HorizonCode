/**
 * openai-usage.test.ts — pure OpenAI-compatible usage decoder (opencode
 * mapUsage port). Frame-shaped inputs, no network.
 */
import { describe, expect, test } from "bun:test";
import { mapOpenAiUsage } from "../../src/core/providers/openai-usage";

describe("mapOpenAiUsage", () => {
  test("rejects non-object frames and empty objects", () => {
    expect(mapOpenAiUsage(undefined)).toBeUndefined();
    expect(mapOpenAiUsage("nope")).toBeUndefined();
    expect(mapOpenAiUsage({})).toBeUndefined();
    expect(mapOpenAiUsage({ prompt_tokens: "21" })).toBeUndefined();
  });

  test("plain frame keeps only the historical fields (no fabricated breakdown)", () => {
    expect(mapOpenAiUsage({ prompt_tokens: 21, completion_tokens: 13 })).toEqual({
      inputTokens: 21,
      outputTokens: 13,
    });
  });

  test("OpenAI cached_tokens dialect derives nonCachedInputTokens and totalTokens", () => {
    expect(
      mapOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      nonCachedInputTokens: 60,
      totalTokens: 120,
    });
  });

  test("cache write dialect (cache_write_tokens + cache_created_input_tokens)", () => {
    expect(
      mapOpenAiUsage({
        prompt_tokens: 200,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
      }),
    ).toEqual({
      inputTokens: 200,
      outputTokens: 10,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 30,
      cacheCreationInputTokens: 30,
      nonCachedInputTokens: 120,
      totalTokens: 210,
    });
    expect(
      mapOpenAiUsage({ prompt_tokens: 200, completion_tokens: 10, cache_created_input_tokens: 30 }),
    ).toMatchObject({ cacheWriteInputTokens: 30, nonCachedInputTokens: 170 });
  });

  test("provider cache dialects: DeepSeek / Zai / DigitalOcean / legacy alias", () => {
    expect(mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 25 })).toMatchObject({
      cacheReadInputTokens: 25,
      nonCachedInputTokens: 75,
    });
    expect(mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 25 })).toMatchObject({
      cacheReadInputTokens: 25,
    });
    expect(mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 25 })).toMatchObject({
      cacheReadInputTokens: 25,
    });
    expect(mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 1, cache_creation_input_tokens: 7 })).toMatchObject({
      cacheWriteInputTokens: 7,
      cacheCreationInputTokens: 7,
    });
  });

  test("reasoning tokens are reported and clamped cache breakdown never goes negative", () => {
    expect(
      mapOpenAiUsage({
        prompt_tokens: 10,
        completion_tokens: 8,
        completion_tokens_details: { reasoning_tokens: 3 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      reasoningTokens: 3,
      nonCachedInputTokens: 10,
      totalTokens: 18,
    });
    expect(
      mapOpenAiUsage({ prompt_tokens: 5, completion_tokens: 1, cached_tokens: 99 }),
    ).toMatchObject({ nonCachedInputTokens: 0 });
  });

  test("Copilot Gemini: reasoning beside completion (total === input+completion+reasoning)", () => {
    expect(
      mapOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 125,
      }),
    ).toMatchObject({ outputTokens: 25, reasoningTokens: 5, totalTokens: 125 });
    // When total is inclusive, completion stays as reported.
    expect(
      mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 5, total_tokens: 120 }),
    ).toMatchObject({ outputTokens: 20 });
  });
});

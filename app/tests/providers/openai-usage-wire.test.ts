/**
 * openai-usage-wire.test.ts — the openai wire core feeds the full usage decoder
 * from top-level `usage` and from the Moonshot `choice.usage` dialect.
 */
import { describe, expect, test } from "bun:test";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import { lastDone, makeRequest, run, sseFrame, sseResponse, withServer } from "./helpers";

async function collect(body: string) {
  return withServer(
    () => sseResponse(body),
    async (server) => {
      const provider = createOpenAiProvider({ apiKey: "sk-test", baseUrl: server.baseUrl });
      const result = run(provider, makeRequest());
      await result.done;
      return result;
    },
  );
}

describe("openai usage wire", () => {
  test("top-level usage with cache + reasoning decodes into additive fields", async () => {
    const body =
      sseFrame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
      sseFrame({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }) +
      sseFrame("[DONE]");
    const result = await collect(body);
    expect(result.thrown).toBeNull();
    expect(lastDone(result.events).usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      reasoningTokens: 5,
      nonCachedInputTokens: 60,
      totalTokens: 120,
    });
  });

  test("Moonshot choice.usage is used when top-level usage is absent", async () => {
    const body =
      sseFrame({
        choices: [
          {
            index: 0,
            delta: { content: "hi" },
            finish_reason: "stop",
            usage: { prompt_tokens: 30, completion_tokens: 9, prompt_cache_hit_tokens: 10 },
          },
        ],
      }) + sseFrame("[DONE]");
    const result = await collect(body);
    expect(result.thrown).toBeNull();
    expect(lastDone(result.events).usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 9,
      cacheReadInputTokens: 10,
      nonCachedInputTokens: 20,
    });
  });
});

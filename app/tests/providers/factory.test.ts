/**
 * factory.test.ts — makeProvider: which provider the configuration selects.
 *
 * The real providers are only ever pointed at a canned localhost server (via
 * baseUrl); a missing key must be explained, not attempted.
 */

import { describe, expect, test } from "bun:test";
import type { HzConfig } from "../../src/core/config";
import { makeProvider } from "../../src/core/providers/index";
import { MOCK_GREETING } from "../../src/core/providers/mock";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { lastDone, makeRequest, run, sseFrame, sseResponse, textOf, withServer } from "./helpers";

function cfg(overrides: Partial<HzConfig> = {}): HzConfig {
  return {
    provider: "mock",
    model: "mock-1",
    sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    ...overrides,
  };
}

async function collect(provider: Provider, req = makeRequest()): Promise<ProviderEvent[]> {
  const result = run(provider, req);
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

/** The canned answer of a successful Claude turn. */
function anthropicTurn(): string {
  return (
    sseFrame({ type: "message_start", message: { usage: { input_tokens: 1 } } }, "message_start") +
    sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from anthropic" } }, "content_block_delta") +
    sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" } }, "message_delta")
  );
}

/** The canned answer of a successful OpenAI turn. */
function openAiTurn(): string {
  return (
    sseFrame({ choices: [{ index: 0, delta: { content: "from openai" }, finish_reason: null }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    sseFrame("[DONE]")
  );
}

describe("makeProvider", () => {
  test("defaults to the offline mock provider", async () => {
    const provider = makeProvider(cfg());
    expect(provider.name).toBe("mock");
    expect(await collect(provider)).toEqual([{ type: "text", text: MOCK_GREETING }, { type: "done", stopReason: "end" }]);
  });

  test("mockFlag wins over a fully configured real provider without touching the network", async () => {
    const provider = makeProvider(
      cfg({ provider: "anthropic", model: "claude-x", apiKey: "sk-ant-test", baseUrl: "http://127.0.0.1:1" }),
      { mockFlag: true },
    );
    expect(provider.name).toBe("mock");
    expect(await collect(provider)).toEqual([{ type: "text", text: MOCK_GREETING }, { type: "done", stopReason: "end" }]);
  });

  test("anthropic with a key and baseUrl streams through the configured endpoint", async () => {
    await withServer(() => sseResponse(anthropicTurn()), async (server) => {
      const provider = makeProvider(cfg({ provider: "anthropic", model: "claude-x", apiKey: "sk-ant-test", baseUrl: server.baseUrl }));
      expect(provider.name).toBe("anthropic");

      const events = await collect(provider, makeRequest({ model: "claude-x" }));
      expect(textOf(events)).toBe("from anthropic");
      expect(lastDone(events).stopReason).toBe("end");
      expect(server.requests[0]!.path).toBe("/v1/messages");
      expect((server.requests[0]!.body as { model: string }).model).toBe("claude-x");
    });
  });

  test("anthropic without a key explains the missing variable instead of calling out", async () => {
    const provider = makeProvider(cfg({ provider: "anthropic", model: "claude-x" }));
    expect(provider.name).toBe("anthropic");

    const events = await collect(provider);
    expect(events).toHaveLength(2);
    const error = events[0]!;
    if (error.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(error)}`);
    expect(error.message).toContain("No API key for anthropic");
    expect(error.message).toContain("ANTHROPIC_API_KEY");
    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });

  test("openai with a key and baseUrl streams through the configured endpoint", async () => {
    await withServer(() => sseResponse(openAiTurn()), async (server) => {
      const provider = makeProvider(cfg({ provider: "openai", model: "gpt-x", apiKey: "sk-oai-test", baseUrl: server.baseUrl }));
      expect(provider.name).toBe("openai");

      const events = await collect(provider, makeRequest({ model: "gpt-x" }));
      expect(textOf(events)).toBe("from openai");
      expect(lastDone(events).stopReason).toBe("end");
      expect(server.requests[0]!.path).toBe("/v1/chat/completions");
      expect((server.requests[0]!.body as { model: string }).model).toBe("gpt-x");
    });
  });

  test("openai without a key explains the missing variable instead of calling out", async () => {
    const provider = makeProvider(cfg({ provider: "openai", model: "gpt-x" }));
    expect(provider.name).toBe("openai");

    const events = await collect(provider);
    expect(events).toHaveLength(2);
    const error = events[0]!;
    if (error.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(error)}`);
    expect(error.message).toContain("No API key for openai");
    expect(error.message).toContain("OPENAI_API_KEY");
    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });
});

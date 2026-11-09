/**
 * openai-compatible.test.ts — the generic OpenAI-chat adapter.
 *
 * One adapter parameterized by { name, baseUrl, credential } unlocks any
 * compatible host (Groq, DeepSeek, Together, a local vLLM, …) as config, not
 * code. These tests point it at a canned localhost server (helpers.ts) and
 * assert three things the registry promises: the Provider.name is the
 * configured host id (not "openai-compatible"), the request lands on
 * `<baseUrl>/v1/chat/completions` with the right model, and the Authorization
 * header is driven by the credential — `Bearer <key>` for an apiKey host, and
 * ABSENT for a keyless (kind "none") host.
 */

import { describe, expect, test } from "bun:test";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { lastDone, makeRequest, run, sseFrame, sseResponse, textOf, withServer } from "./helpers";

/** The canned answer of a successful OpenAI-chat turn. */
function compatibleTurn(text: string): string {
  return (
    sseFrame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    sseFrame("[DONE]")
  );
}

async function collect(provider: Provider, req = makeRequest()): Promise<ProviderEvent[]> {
  const result = run(provider, req);
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

describe("openai-compatible adapter", () => {
  test("Provider.name is the configured host id, not 'openai-compatible'", () => {
    const provider = createOpenAiCompatibleProvider({
      name: "groq",
      baseUrl: "http://127.0.0.1:1",
      credential: { kind: "apiKey", value: "sk-test" },
    });
    expect(provider.name).toBe("groq");
  });

  test("an apiKey host streams through its baseUrl with Authorization: Bearer <key>", async () => {
    await withServer(() => sseResponse(compatibleTurn("from groq")), async (server) => {
      const provider = createOpenAiCompatibleProvider({
        name: "groq",
        baseUrl: server.baseUrl,
        credential: { kind: "apiKey", value: "sk-test" },
      });
      expect(provider.name).toBe("groq");

      const events = await collect(provider, makeRequest({ model: "llama-3.3-70b" }));
      expect(textOf(events)).toBe("from groq");
      expect(lastDone(events).stopReason).toBe("end");

      const request = server.requests[0]!;
      expect(request.path).toBe("/v1/chat/completions");
      expect((request.body as { model: string }).model).toBe("llama-3.3-70b");
      expect(request.headers.authorization).toBe("Bearer sk-test");
    });
  });

  test("an oauth host sends Authorization: Bearer <accessToken>", async () => {
    await withServer(() => sseResponse(compatibleTurn("hi")), async (server) => {
      const provider = createOpenAiCompatibleProvider({
        name: "acme",
        baseUrl: server.baseUrl,
        credential: { kind: "oauth", accessToken: "tok-test" },
      });

      await collect(provider);
      expect(server.requests[0]!.headers.authorization).toBe("Bearer tok-test");
    });
  });

  test("a keyless host (credential kind 'none') sends NO Authorization header", async () => {
    await withServer(() => sseResponse(compatibleTurn("from vllm")), async (server) => {
      const provider = createOpenAiCompatibleProvider({
        name: "local-vllm",
        baseUrl: server.baseUrl,
        credential: { kind: "none" },
      });
      expect(provider.name).toBe("local-vllm");

      const events = await collect(provider, makeRequest({ model: "qwen2.5-coder" }));
      expect(textOf(events)).toBe("from vllm");

      const request = server.requests[0]!;
      expect(request.path).toBe("/v1/chat/completions");
      // The canned server lowercases every header name; a keyless host must not
      // have added one at all.
      expect(request.headers.authorization).toBeUndefined();
    });
  });
});

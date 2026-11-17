/**
 * H-4 (rulings 494 + this slice): the config-selected `formatMessageClass`
 * dialect is consumed by the OpenAI / OpenAI-compatible / Google / Ollama
 * adapters. The default (key absent) stays byte-identical to each adapter's
 * native converter; a non-default dialect changes the rendered wire messages.
 * No dynamic import, no new dependency — everything is a built-in dialect.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import type { HzConfig } from "../../src/core/config";
import { resolveConfigClassKey } from "../../src/core/config-class-keys";
import { makeProvider } from "../../src/core/providers";
import { toGoogleContents } from "../../src/core/providers/google";
import { formatterFromResolvedConfig } from "../../src/core/providers/message-formatter";
import { toOllamaMessages } from "../../src/core/providers/ollama";
import { toOpenAiMessages } from "../../src/core/providers/openai";
import { makeRequest, run, sseResponse, withServer } from "../providers/helpers";

const MESSAGES: ChatMsg[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "glob", arguments: '{"pattern":"*"}' }] },
  { role: "tool", content: "out", toolCallId: "c1", toolName: "glob" },
];

function dialect(name: string): HzConfig["formatMessageClass"] {
  return resolveConfigClassKey("formatMessageClass", name);
}

function baseConfig(overrides: Partial<HzConfig> = {}): HzConfig {
  return {
    provider: "mock",
    model: "m",
    sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    ...overrides,
  };
}

/** Run one provider turn against a canned server and return its recorded body. */
async function postedBody(config: HzConfig, reply: () => Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  await withServer(
    () => reply(),
    async (server) => {
      const cfg: HzConfig = {
        ...config,
        apiKey: "test-key",
        baseUrl: server.baseUrl,
        ...(config.resolved ? { resolved: { ...config.resolved, baseUrl: server.baseUrl } } : {}),
      };
      const result = run(makeProvider(cfg), makeRequest({ messages: [...MESSAGES] }));
      await result.done;
      expect(result.thrown).toBeNull();
      expect(server.requests).toHaveLength(1);
      body = server.requests[0]!.body as Record<string, unknown>;
    },
  );
  return body!;
}

const OPENAI_REPLY = () => sseResponse("data: [DONE]\n\n");
const GOOGLE_REPLY = () => sseResponse("data: {}\n\n");
const OLLAMA_REPLY = () =>
  new Response('{"done":true}\n', { headers: { "content-type": "application/x-ndjson" } });

describe("H-4 formatter selection from config data", () => {
  test("formatterFromResolvedConfig is undefined when unset and dialect-bound when set", () => {
    expect(formatterFromResolvedConfig(undefined)).toBeUndefined();
    expect(formatterFromResolvedConfig(dialect("google"))?.dialect).toBe("google");
    expect(formatterFromResolvedConfig(dialect("openai-compatible"))?.dialect).toBe("openai");
    // A resolved class of a DIFFERENT key must not select a formatter.
    expect(
      formatterFromResolvedConfig({
        key: "modelClass",
        spec: "google",
        modulePath: "core/providers/google",
        via: "short-name",
      }),
    ).toBeUndefined();
  });
});

describe("H-4 adapters consume the selected formatter", () => {
  test("OpenAI: default is byte-identical; a non-default dialect changes messages", async () => {
    const defaults = baseConfig({ provider: "openai" });
    expect(await postedBody(defaults, OPENAI_REPLY)).toMatchObject({
      messages: toOpenAiMessages([...MESSAGES]),
    });

    const switched = baseConfig({ provider: "openai", formatMessageClass: dialect("google") });
    const body = await postedBody(switched, OPENAI_REPLY);
    // Google dialect renders contents/parts, not OpenAI {role, content} objects.
    expect(body.messages).toEqual(toGoogleContents([...MESSAGES]));
    expect(body.messages).not.toEqual(toOpenAiMessages([...MESSAGES]));
  });

  test("Google: default is byte-identical; an OpenAI dialect changes contents", async () => {
    const defaults = baseConfig({ provider: "google" });
    expect(await postedBody(defaults, GOOGLE_REPLY)).toMatchObject({
      contents: toGoogleContents([...MESSAGES]),
    });

    const switched = baseConfig({ provider: "google", formatMessageClass: dialect("openai") });
    const body = await postedBody(switched, GOOGLE_REPLY);
    expect(body.contents).toEqual(toOpenAiMessages([...MESSAGES]));
    expect(body.contents).not.toEqual(toGoogleContents([...MESSAGES]));
  });

  test("Ollama: default is byte-identical; a Google dialect changes messages", async () => {
    const defaults = baseConfig({ provider: "ollama" });
    expect(await postedBody(defaults, OLLAMA_REPLY)).toMatchObject({
      messages: toOllamaMessages([...MESSAGES]),
    });

    const switched = baseConfig({ provider: "ollama", formatMessageClass: dialect("google") });
    const body = await postedBody(switched, OLLAMA_REPLY);
    expect(body.messages).toEqual(toGoogleContents([...MESSAGES]));
    expect(body.messages).not.toEqual(toOllamaMessages([...MESSAGES]));
  });

  test("OpenAI-compatible (registered provider) consumes the formatter too", async () => {
    const compatible = baseConfig({
      provider: "groq",
      model: "m",
      resolved: {
        name: "groq",
        baseUrl: "",
        protocol: "openai-chat",
        credential: { kind: "apiKey", value: "test-key" },
        wantsKey: false,
      },
      formatMessageClass: dialect("ollama"),
    });
    const body = await postedBody(compatible, OPENAI_REPLY);
    expect(body.messages).toEqual(toOllamaMessages([...MESSAGES]));
    expect(body.messages).not.toEqual(toOpenAiMessages([...MESSAGES]));
  });

  test("an unknown/malformed class spec never changes rendering (fail closed to default)", async () => {
    const cfg = baseConfig({
      provider: "openai",
      formatMessageClass: dialect("mock"), // maps to the openai dialect
    });
    expect(await postedBody(cfg, OPENAI_REPLY)).toMatchObject({
      messages: toOpenAiMessages([...MESSAGES]),
    });
  });
});

/**
 * registry.test.ts — the user provider registry (docs/15 §3.1).
 *
 * Mirrors the tolerant MCP template: `parseProviderRegistry` collects rejected
 * entries into `rejected[]` and never throws, a malformed entry is a named skip
 * not a startup failure, and only the USER config file is eligible (a workspace
 * may not name a provider that runs with the user's authority). `loadConfig`
 * then resolves `HZ_PROVIDER=<registered id>` to the openai-compatible adapter,
 * and a registered id that declares a key it cannot find hits the missing-key
 * path — never a silent mock.
 *
 * No real keys: every apiKey is an obvious fake like `sk-test`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  defaultConfigPath,
  loadConfig,
  missingKey,
  parseProviderRegistry,
  PROVIDER_NAMES,
} from "../../src/core/config";
import { makeProvider } from "../../src/core/providers";
import type { ProviderEvent } from "../../src/contracts";
import { lastDone, makeRequest, run, sseFrame, sseResponse, textOf, withServer } from "../providers/helpers";
import { cleanupTemps, tempDir } from "./helpers";

/** A temp HOME holding the user config file (canonical path). */
function homeWithConfig(contents?: string): string {
  const home = tempDir("hz-registry-");
  const file = defaultConfigPath(home);
  if (contents !== undefined) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return file;
}

/** The canned answer of a successful OpenAI-chat turn. */
function compatibleTurn(text: string): string {
  return (
    sseFrame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    sseFrame("[DONE]")
  );
}

async function collect(provider: { stream: (r: ReturnType<typeof makeRequest>) => AsyncIterable<ProviderEvent> }, req = makeRequest()): Promise<ProviderEvent[]> {
  const result = run(provider as never, req);
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

/* ------------------------------ parsing ------------------------------ */

describe("parseProviderRegistry", () => {
  test("no providers section means undefined, never invented defaults", () => {
    expect(parseProviderRegistry(undefined)).toBeUndefined();
    expect(parseProviderRegistry(null)).toBeUndefined();
    expect(parseProviderRegistry([])).toBeUndefined();
  });

  test("a valid entry parses with the openai-chat default protocol", () => {
    const parsed = parseProviderRegistry([
      { id: "groq", baseUrl: "https://api.groq.com/openai", apiKey: "sk-test", models: ["llama-3.3-70b", "mixtral"] },
    ]);
    expect(parsed).toEqual({
      providers: [{ id: "groq", baseUrl: "https://api.groq.com/openai", protocol: "openai-chat", apiKey: "sk-test", models: ["llama-3.3-70b", "mixtral"] }],
      rejected: [],
    });
  });

  test("a wrong-shaped section is a refusal list, never a crash", () => {
    expect(parseProviderRegistry({ not: "an array" })).toEqual({ providers: [], rejected: ["providers must be an array"] });
  });

  test("bad entries land in rejected[] with readable reasons and the suite never throws", () => {
    const parsed = parseProviderRegistry([
      { id: "ok", baseUrl: "https://ok.example", envKey: "OK_KEY" },
      { id: "Bad Id", baseUrl: "https://x.example" },
      { id: "openai", baseUrl: "https://x.example" }, // collides with a built-in
      { id: "no-base" },
      { id: "bad-scheme", baseUrl: "ftp://x.example" },
      { id: "bad-proto", baseUrl: "https://x.example", protocol: "anthropic-messages" },
      { id: "ok", baseUrl: "https://dup.example" }, // duplicate id
    ]);
    expect(parsed?.providers).toEqual([{ id: "ok", baseUrl: "https://ok.example", protocol: "openai-chat", envKey: "OK_KEY" }]);
    expect(parsed?.rejected.length).toBe(6);
    const rejected = parsed?.rejected.join("\n") ?? "";
    expect(rejected).toContain("must match [a-z0-9-]");
    expect(rejected).toContain("collides with a built-in provider");
    expect(rejected).toContain("baseUrl must be a non-empty string");
    expect(rejected).toContain("baseUrl must be an http(s) URL");
    expect(rejected).toContain('protocol must be "openai-chat"');
    expect(rejected).toContain("duplicates provider id");
  });

  test("a registered id may never shadow a built-in (PROVIDER_NAMES stays the 5)", () => {
    expect([...PROVIDER_NAMES]).toEqual(["anthropic", "openai", "google", "ollama", "mock"]);
    // Even with a registry present, the constant is untouched.
    parseProviderRegistry([{ id: "groq", baseUrl: "https://api.groq.com/openai" }]);
    expect([...PROVIDER_NAMES]).toEqual(["anthropic", "openai", "google", "ollama", "mock"]);
  });
});

/* --------------------------- loadConfig resolution --------------------------- */

describe("loadConfig resolves a registered provider", () => {
  const registryConfig = (): string =>
    homeWithConfig(
      JSON.stringify({
        providers: [
          { id: "groq", baseUrl: "https://api.groq.com/openai", envKey: "GROQ_API_KEY", models: ["llama-3.3-70b"] },
          { id: "local-vllm", baseUrl: "http://127.0.0.1:8000" },
        ],
      }),
    );

  test("HZ_PROVIDER=<registered id> selects the entry, its model and credential", () => {
    const config = loadConfig({ HZ_PROVIDER: "groq", GROQ_API_KEY: "sk-test" }, registryConfig());
    expect(config.provider).toBe("groq");
    expect(config.sources.provider).toBe("env");
    expect(config.model).toBe("llama-3.3-70b");
    expect(config.baseUrl).toBe("https://api.groq.com/openai");
    expect(config.resolved).toEqual({
      name: "groq",
      baseUrl: "https://api.groq.com/openai",
      protocol: "openai-chat",
      credential: { kind: "apiKey", value: "sk-test" },
      wantsKey: true,
    });
    expect(missingKey(config)).toBeNull();
  });

  test("a keyless entry resolves to credential kind 'none' and needs no key", () => {
    const config = loadConfig({ HZ_PROVIDER: "local-vllm" }, registryConfig());
    expect(config.provider).toBe("local-vllm");
    expect(config.resolved?.credential).toEqual({ kind: "none" });
    expect(config.resolved?.wantsKey).toBe(false);
    expect(missingKey(config)).toBeNull();
  });

  test("a registered id that wants a key but cannot find one reports the missing key", () => {
    const config = loadConfig({ HZ_PROVIDER: "groq" }, registryConfig());
    expect(config.provider).toBe("groq");
    expect(config.resolved?.credential).toEqual({ kind: "none" });
    expect(config.resolved?.wantsKey).toBe(true);
    expect(missingKey(config)).toBe("HZ_API_KEY");
  });

  test("the file can select a registered provider too", () => {
    const file = homeWithConfig(
      JSON.stringify({ provider: "groq", providers: [{ id: "groq", baseUrl: "https://api.groq.com/openai", apiKey: "sk-test" }] }),
    );
    const config = loadConfig({}, file);
    expect(config.provider).toBe("groq");
    expect(config.sources.provider).toBe("file");
    expect(config.resolved?.credential).toEqual({ kind: "apiKey", value: "sk-test" });
  });

  test("a modelless registered entry resolves to the empty-model sentinel, never mock-1", () => {
    // `local-vllm` declares no models[]; with no HZ_MODEL/file model it must NOT
    // inherit the mock's default id (forwarding "mock-1" to a real host is the
    // opaque-400 silent-wrong-thing the fail-loud default exists to kill).
    const config = loadConfig({ HZ_PROVIDER: "local-vllm" }, registryConfig());
    expect(config.provider).toBe("local-vllm");
    expect(config.model).toBe("");
    expect(config.model).not.toBe("mock-1");
    // An explicit HZ_MODEL still wins for the same entry.
    const configured = loadConfig({ HZ_PROVIDER: "local-vllm", HZ_MODEL: "my-model" }, registryConfig());
    expect(configured.model).toBe("my-model");
  });

  test("an unknown, unregistered id still falls back to mock at the config layer", () => {
    // makeProvider owns the fail-loud default when handed one directly; the
    // config layer keeps the historic mock fallback for a bare typo.
    expect(loadConfig({ HZ_PROVIDER: "prism" }, registryConfig()).provider).toBe("mock");
  });
});

/* ------------------------- makeProvider end to end ------------------------- */

describe("makeProvider with a registered provider", () => {
  test("HZ_PROVIDER=<registered id> streams through the openai-compatible adapter", async () => {
    await withServer(() => sseResponse(compatibleTurn("from groq")), async (server) => {
      const file = homeWithConfig(
        JSON.stringify({ providers: [{ id: "groq", baseUrl: server.baseUrl, apiKey: "sk-test", models: ["llama-3.3-70b"] }] }),
      );
      const config = loadConfig({ HZ_PROVIDER: "groq" }, file);
      const provider = makeProvider(config);
      expect(provider.name).toBe("groq");

      const events = await collect(provider, makeRequest({ model: config.model }));
      expect(textOf(events)).toBe("from groq");
      expect(lastDone(events).stopReason).toBe("end");

      const request = server.requests[0]!;
      expect(request.path).toBe("/v1/chat/completions");
      expect((request.body as { model: string }).model).toBe("llama-3.3-70b");
      expect(request.headers.authorization).toBe("Bearer sk-test");
    });
  });

  test("a registered id with no key and no envKey resolves to the missing-key error path", async () => {
    const file = homeWithConfig(JSON.stringify({ providers: [{ id: "needs-key", baseUrl: "http://127.0.0.1:1", envKey: "NEEDS_KEY" }] }));
    const config = loadConfig({ HZ_PROVIDER: "needs-key" }, file);
    const provider = makeProvider(config);
    expect(provider.name).toBe("needs-key");

    const events = await collect(provider);
    expect(events).toHaveLength(2);
    const error = events[0]!;
    if (error.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(error)}`);
    expect(error.message).toContain("No API key for needs-key");
    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });

  test("a modelless registered provider fails loud instead of forwarding a placeholder model", async () => {
    const file = homeWithConfig(JSON.stringify({ providers: [{ id: "local-vllm", baseUrl: "http://127.0.0.1:1" }] }));
    const config = loadConfig({ HZ_PROVIDER: "local-vllm" }, file);
    expect(config.model).toBe("");
    const provider = makeProvider(config);
    expect(provider.name).toBe("local-vllm");

    const events = await collect(provider);
    expect(events).toHaveLength(2);
    const error = events[0]!;
    if (error.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(error)}`);
    expect(error.message).toContain("No model configured for \"local-vllm\"");
    expect(error.message).toContain("HZ_MODEL");
    expect(error.message).toContain("models[]");
    expect(error.message).not.toContain("mock-1");
    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });

  test("a keyless registered provider streams with no Authorization header", async () => {
    await withServer(() => sseResponse(compatibleTurn("from vllm")), async (server) => {
      const file = homeWithConfig(JSON.stringify({ providers: [{ id: "local-vllm", baseUrl: server.baseUrl, models: ["qwen2.5-coder"] }] }));
      const config = loadConfig({ HZ_PROVIDER: "local-vllm" }, file);
      const provider = makeProvider(config);

      await collect(provider);
      expect(server.requests[0]!.headers.authorization).toBeUndefined();
    });
  });
});

afterAll(() => {
  cleanupTemps();
});

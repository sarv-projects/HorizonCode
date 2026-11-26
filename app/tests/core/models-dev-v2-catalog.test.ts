/**
 * models-dev-v2-catalog.test.ts — verifies models.dev v1/v2 decoding,
 * capability & cost preservation, R50 unknown-cost honesty, airgap kill-switch,
 * 404 v1 mirror fallback, catalogCost tier lookup, and catalog-backed provider
 * resolution & protocol dispatch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeOAuthTokenDb } from "../../src/core/auth/credential-db";
import {
  CATALOG_PATH,
  CATALOG_V1_PATH,
  catalogCost,
  catalogModel,
  countCatalogModels,
  curatedCatalog,
  decodeCatalog,
  decodeModel,
  fetchLiveCatalog,
  getCatalogCacheRevision,
  isV1Catalog,
  loadCatalog,
  MINIMUM_PROVIDERS,
  normalizeV1ToV2,
  readCatalogCacheMeta,
  writeCatalogCache,
} from "../../src/core/catalog/catalog";
import {
  DEFAULT_CATALOG_REFRESH_TTL_MS,
  makeModelsCatalogPollNetGuard,
  modelsCatalogFetchUrl,
  parseModelsPollIntervalMs,
  refreshModelsCatalog,
  runModelsCatalogPollOnce,
  startModelsCatalogPoll,
  triggerBootCatalogRefresh,
} from "../../src/core/catalog/catalog-poll";
import { defaultConfigPath, loadConfig, missingKey, type HzConfig } from "../../src/core/config";
import { makeProvider } from "../../src/core/providers";
import { isModelsRefreshCommand, runModelsSlashRefresh } from "../../src/tui/models-slash";
import type { ProviderEvent } from "../../src/contracts";
import { makeRequest, run } from "../providers/helpers";

const temps: string[] = [];
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows SQLite handle release */
    }
  }
});

async function collectEvents(provider: ReturnType<typeof makeProvider>): Promise<ProviderEvent[]> {
  const res = run(provider as never, makeRequest({ model: "test-model" }));
  await res.done;
  expect(res.thrown).toBeNull();
  return res.events;
}

function padV1Providers(base: Record<string, unknown>, total: number = MINIMUM_PROVIDERS): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  let idx = 0;
  while (Object.keys(out).length < total) {
    const id = `pad-v1-${idx++}`;
    out[id] = {
      id,
      name: `Pad ${idx}`,
      npm: "@ai-sdk/openai-compatible",
      api: `https://${id}.example.test/v1`,
      env: [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
      models: {
        [`m-${idx}`]: {
          id: `m-${idx}`,
          tool_call: true,
          limit: { context: 65536, output: 8192 },
        },
      },
    };
  }
  return out;
}

function padV2Providers(base: Record<string, unknown>, total: number = MINIMUM_PROVIDERS): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  let idx = 0;
  while (Object.keys(out).length < total) {
    const id = `pad-v2-${idx++}`;
    out[id] = {
      id,
      name: `Pad V2 ${idx}`,
      protocol: "openai-chat",
      baseUrl: `https://${id}.example.test/v1`,
      env: [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
      models: {
        [`m-${idx}`]: {
          id: `m-${idx}`,
          limit: { context: 65536, output: 8192 },
          capabilities: { tools: { supported: true } },
        },
      },
    };
  }
  return out;
}

describe("v1-to-v2 detection and normalization", () => {
  test("isV1Catalog distinguishes v1 from v2 and curated snapshots", () => {
    const v1Sample = {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        npm: "@ai-sdk/deepseek",
        api: "https://api.deepseek.com/v1",
        env: ["DEEPSEEK_API_KEY"],
        models: {
          "deepseek-reasoner": {
            id: "deepseek-reasoner",
            name: "DeepSeek R1",
            tool_call: true,
            reasoning: true,
            temperature: true,
            structured_output: false,
            release_date: "2025-01-20",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 8192 },
            cost: { input: 0.55, output: 2.19, cache_read: 0.14, context_over_200k: { input: 1.1, output: 4.38 } },
          },
        },
      },
    };

    const v2Sample = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        env: ["ANTHROPIC_API_KEY"],
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            limit: { context: 1000000, output: 64000 },
            capabilities: {
              tools: { supported: true },
              reasoning: { supported: true, toggle: true, effort: ["low", "medium", "high"] },
              cache: { explicit: true },
            },
            cost: { text: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
          },
        },
      },
    };

    expect(isV1Catalog(v1Sample)).toBe(true);
    expect(isV1Catalog(v2Sample)).toBe(false);
    expect(isV1Catalog(curatedCatalog())).toBe(false);
    expect(isV1Catalog(null)).toBe(false);
  });

  test("v1 and v2 payloads decode into the same rich CatalogModel and CatalogProvider shape", () => {
    const v1Payload = {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        npm: "@ai-sdk/deepseek",
        api: "https://api.deepseek.com/v1",
        env: ["DEEPSEEK_API_KEY"],
        models: {
          "deepseek-r1": {
            id: "deepseek-r1",
            name: "DeepSeek R1",
            family: "deepseek-r",
            status: "ga",
            release_date: "2025-01-20",
            tool_call: true,
            reasoning: true,
            temperature: true,
            structured_output: true,
            interleaved: { field: "reasoning_content" },
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 256000, output: 32768 },
            cost: {
              input: 0.55,
              output: 2.19,
              cache_read: 0.14,
              cache_write: 0.55,
              context_over_200k: { input: 1.1, output: 4.38, cache_read: 0.28 },
            },
          },
        },
      },
    };

    const normalized = normalizeV1ToV2(v1Payload);
    expect(isV1Catalog(normalized)).toBe(false);

    const decoded = decodeCatalog(v1Payload);
    expect(decoded.rejected).toEqual([]);
    const provider = decoded.providers.deepseek!;
    expect(provider.name).toBe("DeepSeek");
    expect(provider.env).toEqual(["DEEPSEEK_API_KEY"]);
    expect(provider.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(provider.protocol).toBe("openai-chat");

    const model = provider.models["deepseek-r1"]!;
    expect(model.name).toBe("DeepSeek R1");
    expect(model.family).toBe("deepseek-r");
    expect(model.status).toBe("ga");
    expect(model.releasedAt).toBe("2025-01-20");
    expect(model.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(model.capabilities).toEqual({
      tools: true,
      reasoning: true,
      reasoningOptions: { interleaved: { field: "reasoning_content" } },
      temperature: true,
      structuredOutput: true,
      vision: true,
      cacheControl: true,
    });
    expect(model.cost).toEqual({
      input: 0.55,
      output: 2.19,
      cacheReadPerM: 0.14,
      cacheWritePerM: 0.55,
      tiers: [{ size: 200_000, input: 1.1, output: 4.38, cacheReadPerM: 0.28 }],
    });
    expect(model.compatibility).toEqual({ interleaved: { field: "reasoning_content" } });
  });
});

describe("v2.0 decodeModel fix and R50 cost honesty", () => {
  test("decodeModel preserves v2.0 nested capabilities and cost.text with overrides", () => {
    const model = decodeModel("anthropic", "claude-sonnet-4-6", {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      family: "claude-sonnet",
      status: "active",
      releasedAt: "2026-02-01",
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: {
        tools: { supported: true },
        reasoning: {
          supported: true,
          toggle: true,
          effort: ["low", "medium", "high"],
          budget: { min: 1024, max: 32000, default: 8192 },
        },
        cache: { explicit: true },
        temperature: true,
        structured_output: { supported: true },
      },
      cost: {
        text: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
          overrides: [
            {
              condition: { context_over: 200_000 },
              input: 6,
              output: 22.5,
              cache_read: 0.6,
              cache_write: 7.5,
            },
          ],
        },
      },
    });

    if (typeof model === "string") throw new Error(model);
    expect(model.capabilities).toEqual({
      tools: true,
      reasoning: true,
      reasoningOptions: {
        toggle: true,
        effort: ["low", "medium", "high"],
        budget: { min: 1024, max: 32000, default: 8192 },
      },
      cacheControl: true,
      temperature: true,
      structuredOutput: true,
      vision: true,
    });
    expect(model.cost).toEqual({
      input: 3,
      output: 15,
      cacheReadPerM: 0.3,
      cacheWritePerM: 3.75,
      tiers: [{ size: 200_000, input: 6, output: 22.5, cacheReadPerM: 0.6, cacheWritePerM: 7.5 }],
    });
  });

  test("R50: missing or non-per-token cost stays undefined, never $0; explicit 0 is preserved", () => {
    const noCost = decodeModel("acme", "m-none", { limit: { context: 32768 } });
    if (typeof noCost === "string") throw new Error(noCost);
    expect(noCost.cost).toBeUndefined();

    const nonPerToken = decodeModel("acme", "m-img", {
      limit: { context: 32768 },
      cost: { image: 0.04, per_request: 0.01 },
    });
    if (typeof nonPerToken === "string") throw new Error(nonPerToken);
    expect(nonPerToken.cost).toBeUndefined();

    const emptyTextCost = decodeModel("acme", "m-empty", {
      limit: { context: 32768 },
      cost: { text: {} },
    });
    if (typeof emptyTextCost === "string") throw new Error(emptyTextCost);
    expect(emptyTextCost.cost).toBeUndefined();

    const explicitZero = decodeModel("nvidia", "m-free", {
      limit: { context: 131072 },
      cost: { text: { input: 0, output: 0 } },
    });
    if (typeof explicitZero === "string") throw new Error(explicitZero);
    expect(explicitZero.cost).toEqual({ input: 0, output: 0 });
  });

  test("catalogCost selects matching context tier and returns undefined for unpriced models", () => {
    const catalog = decodeCatalog({
      anthropic: {
        id: "anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            limit: { context: 1_000_000 },
            cost: {
              text: {
                input: 3,
                output: 15,
                cache_read: 0.3,
                overrides: [
                  { condition: { context_over: 200_000 }, input: 6, output: 22.5 },
                  { condition: { context_over: 500_000 }, input: 9, output: 30 },
                ],
              },
            },
          },
          "unpriced-model": {
            id: "unpriced-model",
            limit: { context: 128_000 },
          },
        },
      },
    });

    expect(catalogCost(catalog, "anthropic", "claude-sonnet-4-6")).toEqual({
      input: 3,
      output: 15,
      cacheReadPerM: 0.3,
    });
    expect(catalogCost(catalog, "anthropic", "claude-sonnet-4-6", 150_000)).toEqual({
      input: 3,
      output: 15,
      cacheReadPerM: 0.3,
    });
    expect(catalogCost(catalog, "anthropic", "claude-sonnet-4-6", 250_000)).toEqual({
      input: 6,
      output: 22.5,
      cacheReadPerM: 0.3,
      tierSize: 200_000,
    });
    expect(catalogCost(catalog, "anthropic", "claude-sonnet-4-6", 600_000)).toEqual({
      input: 9,
      output: 30,
      cacheReadPerM: 0.3,
      tierSize: 500_000,
    });
    // R50: missing cost or missing model stays undefined.
    expect(catalogCost(catalog, "anthropic", "unpriced-model", 10_000)).toBeUndefined();
    expect(catalogCost(catalog, "anthropic", "no-such-model")).toBeUndefined();
  });

  test("loadCatalog attaches a SHA-256 digest for curated and override sources", () => {
    const curated = loadCatalog({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, makeTemp("hz-dig-home-"));
    expect(curated.source).toBe("curated");
    expect(curated.digest).toMatch(/^[0-9a-f]{64}$/);

    const dir = makeTemp("hz-dig-ov-");
    const snapFile = path.join(dir, "v2.json");
    writeFileSync(snapFile, JSON.stringify(padV2Providers({})), "utf8");
    const override = loadCatalog({ HZ_MODELS_SNAPSHOT: snapFile }, makeTemp("hz-dig-home2-"));
    expect(override.source).toBe("override");
    expect(override.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(override.digest).not.toBe(curated.digest);
  });
});

describe("HZ_DISABLE_MODELS_FETCH and HZ_MODELS_URL 404 v1 fallback", () => {
  test("HZ_DISABLE_MODELS_FETCH=1 blocks fetchLiveCatalog and catalog-poll before any network or guard call", async () => {
    let guardCalled = false;
    let fetchCalled = false;
    await expect(
      fetchLiveCatalog(undefined, {
        env: { HZ_DISABLE_MODELS_FETCH: "1" },
        assertNetFetch: () => {
          guardCalled = true;
        },
        fetcher: async () => {
          fetchCalled = true;
          return { status: 200, body: "{}" };
        },
      }),
    ).rejects.toThrow(/HZ_DISABLE_MODELS_FETCH/);
    expect(guardCalled).toBe(false);
    expect(fetchCalled).toBe(false);

    expect(parseModelsPollIntervalMs({ HZ_MODELS_POLL_MS: "120000", HZ_DISABLE_MODELS_FETCH: "1" })).toBeUndefined();
    const notices: string[] = [];
    await runModelsCatalogPollOnce({
      env: { HZ_DISABLE_MODELS_FETCH: "1" },
      onNotice: (m) => notices.push(m),
      assertNetFetch: () => {
        guardCalled = true;
      },
      fetchLive: async () => {
        fetchCalled = true;
        return { catalog: { providers: {}, rejected: [] }, notModified: false };
      },
    });
    expect(guardCalled).toBe(false);
    expect(fetchCalled).toBe(false);
    expect(notices.some((n) => n.includes("HZ_DISABLE_MODELS_FETCH"))).toBe(true);

    const stop = startModelsCatalogPoll({ intervalMs: 60_000, env: { HZ_DISABLE_MODELS_FETCH: "1" } });
    expect(typeof stop).toBe("function");
    stop();
  });

  test("HZ_MODELS_URL falls back to /api.json on HTTP 404 and checks assertNetFetch on both URLs", async () => {
    const mirror = "https://mirror.internal.test";
    const guardedUrls: string[] = [];
    const fetchedUrls: string[] = [];
    const v1Body = JSON.stringify(
      padV1Providers({
        deepseek: {
          id: "deepseek",
          name: "DeepSeek",
          npm: "@ai-sdk/deepseek",
          api: "https://api.deepseek.com/v1",
          env: ["DEEPSEEK_API_KEY"],
          models: {
            "deepseek-chat": {
              id: "deepseek-chat",
              tool_call: true,
              reasoning: false,
              limit: { context: 128000, output: 8192 },
              cost: { input: 0.27, output: 1.1 },
            },
          },
        },
      }),
    );

    const netGuard = makeModelsCatalogPollNetGuard(
      async (url) => {
        guardedUrls.push(url);
        return { decision: "allow" };
      },
      { HZ_MODELS_URL: mirror },
    );

    expect(modelsCatalogFetchUrl(undefined, { HZ_MODELS_URL: mirror })).toBe(`${mirror}${CATALOG_PATH}`);

    const res = await fetchLiveCatalog(undefined, {
      env: { HZ_MODELS_URL: mirror },
      assertNetFetch: netGuard,
      fetcher: async (url) => {
        fetchedUrls.push(url);
        if (url.endsWith(CATALOG_PATH)) return { status: 404, body: "Not Found" };
        if (url.endsWith(CATALOG_V1_PATH)) return { status: 200, body: v1Body, etag: '"v1-etag"' };
        return { status: 500, body: "unexpected" };
      },
    });

    expect(fetchedUrls).toEqual([`${mirror}${CATALOG_PATH}`, `${mirror}${CATALOG_V1_PATH}`]);
    expect(guardedUrls).toEqual([`${mirror}${CATALOG_PATH}`, `${mirror}${CATALOG_V1_PATH}`]);
    expect(res.notModified).toBe(false);
    expect(res.etag).toBe('"v1-etag"');
    const ds = catalogModel(res.catalog, "deepseek", "deepseek-chat");
    expect(ds?.capabilities?.tools).toBe(true);
    expect(ds?.cost?.input).toBe(0.27);
  });
});

describe("catalog-backed provider resolution and protocol dispatch", () => {
  function writeRichCatalogSnapshot(): string {
    const dir = makeTemp("hz-cat-prov-");
    const file = path.join(dir, "catalog.json");
    const payload = padV2Providers({
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        protocol: "openai-chat",
        baseUrl: "https://api.deepseek.com/v1",
        env: ["DEEPSEEK_API_KEY"],
        defaultModel: "deepseek-chat",
        models: {
          "deepseek-chat": { id: "deepseek-chat", limit: { context: 128000, output: 8192 } },
        },
      },
      "custom-anthropic": {
        id: "custom-anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://anthropic-proxy.example.test",
        env: ["CUSTOM_ANTHROPIC_KEY"],
        defaultModel: "claude-sonnet-4-6",
        models: {
          "claude-sonnet-4-6": { id: "claude-sonnet-4-6", limit: { context: 200000, output: 64000 } },
        },
      },
      "custom-responses": {
        id: "custom-responses",
        protocol: "openai-responses",
        baseUrl: "https://openai-proxy.example.test",
        env: ["CUSTOM_OPENAI_KEY"],
        defaultModel: "gpt-5",
        models: {
          "gpt-5": { id: "gpt-5", limit: { context: 400000, output: 128000 } },
        },
      },
      "custom-gemini": {
        id: "custom-gemini",
        protocol: "google-gemini",
        baseUrl: "https://gemini-proxy.example.test",
        env: ["CUSTOM_GEMINI_KEY"],
        defaultModel: "gemini-2.5-pro",
        models: {
          "gemini-2.5-pro": { id: "gemini-2.5-pro", limit: { context: 1048576, output: 65536 } },
        },
      },
      "custom-ollama": {
        id: "custom-ollama",
        protocol: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        defaultModel: "llama3.1",
        models: {
          "llama3.1": { id: "llama3.1", limit: { context: 131072 } },
        },
      },
      "no-protocol-provider": {
        id: "no-protocol-provider",
        baseUrl: "https://broken.example.test",
        models: {
          "m-1": { id: "m-1", limit: { context: 65536 } },
        },
      },
    });
    writeFileSync(file, JSON.stringify(payload), "utf8");
    return file;
  }

  test("loadConfig synthesizes ResolvedProvider from catalog using catalogProvider.env[], HZ_API_KEY, or auth store", () => {
    const snap = writeRichCatalogSnapshot();
    const home = makeTemp("hz-cat-home-");
    const cfgFile = defaultConfigPath(home);

    // 1. Resolves via catalogProvider.env[]
    const cfgEnv = loadConfig(
      { HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-ds-env" },
      cfgFile,
    );
    expect(cfgEnv.provider).toBe("deepseek");
    expect(cfgEnv.model).toBe("deepseek-chat");
    expect(cfgEnv.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfgEnv.resolved?.protocol).toBe("openai-chat");
    expect(cfgEnv.resolved?.credential).toEqual({ kind: "apiKey", value: "sk-ds-env" });
    expect(missingKey(cfgEnv)).toBeNull();

    // 2. HZ_API_KEY wins over catalogProvider.env[]
    const cfgHz = loadConfig(
      {
        HOME: home,
        HZ_MODELS_SNAPSHOT: snap,
        HZ_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "sk-ds-env",
        HZ_API_KEY: "sk-hz-override",
      },
      cfgFile,
    );
    expect(cfgHz.resolved?.credential).toEqual({ kind: "apiKey", value: "sk-hz-override" });

    // 3. Missing key reports catalog env var cleanly
    const cfgMissing = loadConfig({ HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "deepseek" }, cfgFile);
    expect(cfgMissing.resolved?.credential).toEqual({ kind: "none" });
    expect(cfgMissing.resolved?.wantsKey).toBe(true);
    expect(missingKey(cfgMissing)).toBe("DEEPSEEK_API_KEY");

    // 4. Resolves via credentialFromStore when env is absent
    writeOAuthTokenDb(
      {
        provider: "deepseek",
        accessToken: "oauth-tok-from-store",
        tokenUrl: "https://auth.deepseek.test/token",
        clientId: "hz-test-client",
        expiresAt: Date.now() + 3_600_000,
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    const cfgStore = loadConfig({ HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "deepseek" }, cfgFile);
    expect(cfgStore.resolved?.credential).toMatchObject({ kind: "oauth", accessToken: "oauth-tok-from-store" });
    expect(missingKey(cfgStore)).toBeNull();
  });

  test("user config.providers[] and built-in providers retain priority; unknown providers still fail loud", async () => {
    const snap = writeRichCatalogSnapshot();
    const home = makeTemp("hz-prio-home-");
    const cfgFile = defaultConfigPath(home);
    mkdirSync(path.dirname(cfgFile), { recursive: true });
    writeFileSync(
      cfgFile,
      JSON.stringify({
        providers: [
          {
            id: "deepseek",
            baseUrl: "https://user-override.example.test/v1",
            apiKey: "sk-user-cfg",
            models: ["user-ds-model"],
          },
        ],
      }),
    );

    const userWins = loadConfig({ HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "deepseek" }, cfgFile);
    expect(userWins.baseUrl).toBe("https://user-override.example.test/v1");
    expect(userWins.model).toBe("user-ds-model");

    // Built-in anthropic stays on built-in path (resolved === undefined)
    const builtin = loadConfig(
      { HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" },
      cfgFile,
    );
    expect(builtin.provider).toBe("anthropic");
    expect(builtin.resolved).toBeUndefined();

    // Unknown provider or catalog provider without supported protocol fails loud
    const unknown = loadConfig({ HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "totally-unknown" }, cfgFile);
    expect(unknown.resolved).toBeUndefined();
    const unknownEvents = await collectEvents(makeProvider(unknown));
    expect(unknownEvents.some((e) => e.type === "error" && e.message.includes('Unknown provider "totally-unknown"'))).toBe(
      true,
    );

    const noProto = loadConfig({ HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: "no-protocol-provider" }, cfgFile);
    expect(noProto.resolved).toBeUndefined();
    const noProtoEvents = await collectEvents(makeProvider(noProto));
    expect(
      noProtoEvents.some((e) => e.type === "error" && e.message.includes('Unknown provider "no-protocol-provider"')),
    ).toBe(true);
  });

  test("makeProvider dispatches all 5 protocols and fails closed on unsupported protocol", async () => {
    const snap = writeRichCatalogSnapshot();
    const home = makeTemp("hz-dispatch-home-");
    const cfgFile = defaultConfigPath(home);

    const cases: Array<{ id: string; envKey?: string }> = [
      { id: "deepseek", envKey: "DEEPSEEK_API_KEY" },
      { id: "custom-anthropic", envKey: "CUSTOM_ANTHROPIC_KEY" },
      { id: "custom-responses", envKey: "CUSTOM_OPENAI_KEY" },
      { id: "custom-gemini", envKey: "CUSTOM_GEMINI_KEY" },
      { id: "custom-ollama" },
    ];

    for (const c of cases) {
      const env: Record<string, string> = { HOME: home, HZ_MODELS_SNAPSHOT: snap, HZ_PROVIDER: c.id };
      if (c.envKey) env[c.envKey] = "sk-test-key";
      const cfg = loadConfig(env, cfgFile);
      const provider = makeProvider(cfg);
      expect(provider.name).toBe(c.id);
    }

    // Fail closed when an unsupported protocol is injected into resolved.protocol
    const badCfg: HzConfig = {
      provider: "weird-proto",
      model: "m-1",
      baseUrl: "https://weird.example.test",
      resolved: {
        name: "weird-proto",
        baseUrl: "https://weird.example.test",
        protocol: "bedrock-converse" as never,
        credential: { kind: "apiKey", value: "sk-test" },
        wantsKey: true,
      },
      sources: { provider: "env", model: "env", baseUrl: "default", apiKey: "env" },
    };
    const badEvents = await collectEvents(makeProvider(badCfg));
    expect(badEvents.some((e) => e.type === "error" && e.message.includes('Unsupported protocol "bedrock-converse"'))).toBe(
      true,
    );
  });
});

describe("OpenCode trimmed v2 snapshot & full provider parity", () => {
  test("bundled models-dev.snapshot.json loads 200+ providers and 8000+ models with nested v2 cost and protocols", () => {
    const home = makeTemp("hz-opencode-snap-");
    const prev = process.env.HZ_NO_COMMITTED_SNAPSHOT;
    delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
    try {
      const loaded = loadCatalog({}, home);
      expect(loaded.source).toBe("snapshot");
      const providerIds = Object.keys(loaded.providers);
      expect(providerIds.length).toBeGreaterThanOrEqual(200);
      expect(countCatalogModels(loaded)).toBeGreaterThan(8000);

      // Every single provider in OpenCode's trimmed v2 snapshot must have a
      // resolved wire protocol and baseUrl.
      const missingProto = providerIds.filter((id) => !loaded.providers[id]!.protocol);
      const missingUrl = providerIds.filter((id) => !loaded.providers[id]!.baseUrl);
      expect(missingProto).toEqual([]);
      expect(missingUrl).toEqual([]);

      // Verify nested v2 cost.text.input.price & cache decoding on Anthropic models.
      const anthropicModels = Object.values(loaded.providers.anthropic!.models);
      const pricedAnthropic = anthropicModels.find((m) => m.cost?.input !== undefined && m.cost?.output !== undefined);
      expect(pricedAnthropic).toBeDefined();
      expect(pricedAnthropic!.capabilities?.cacheControl).toBe(true);
      expect(pricedAnthropic!.capabilities?.vision).toBe(true);
    } finally {
      if (prev !== undefined) process.env.HZ_NO_COMMITTED_SNAPSHOT = prev;
    }
  });

  test("resolves and dispatches major, gateway, cloud, and local keyless OpenCode providers", () => {
    const home = makeTemp("hz-opencode-parity-");
    const cfgFile = defaultConfigPath(home);
    const prev = process.env.HZ_NO_COMMITTED_SNAPSHOT;
    delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
    try {
      // Built-ins + major OpenCode providers + gateways + cloud templates + local keyless
      const cases: Array<{
        id: string;
        env: Record<string, string>;
        expectedProtocol?: string;
        expectedUrlContains?: string;
        expectKeyless?: boolean;
      }> = [
        { id: "anthropic", env: { ANTHROPIC_API_KEY: "sk-ant" } },
        { id: "openai", env: { OPENAI_API_KEY: "sk-oai" } },
        { id: "google", env: { GEMINI_API_KEY: "sk-gem" } },
        { id: "xai", env: { XAI_API_KEY: "sk-xai" }, expectedProtocol: "openai-responses", expectedUrlContains: "api.x.ai" },
        { id: "deepseek", env: { DEEPSEEK_API_KEY: "sk-ds" }, expectedProtocol: "openai-chat", expectedUrlContains: "api.deepseek.com" },
        { id: "groq", env: { GROQ_API_KEY: "gsk-test" }, expectedProtocol: "openai-chat", expectedUrlContains: "api.groq.com" },
        { id: "openrouter", env: { OPENROUTER_API_KEY: "sk-or" }, expectedProtocol: "openai-chat", expectedUrlContains: "openrouter.ai" },
        { id: "mistral", env: { MISTRAL_API_KEY: "sk-mis" }, expectedProtocol: "openai-chat", expectedUrlContains: "api.mistral.ai" },
        { id: "fireworks-ai", env: { FIREWORKS_API_KEY: "sk-fw" }, expectedProtocol: "openai-chat", expectedUrlContains: "fireworks.ai" },
        { id: "togetherai", env: { TOGETHER_API_KEY: "sk-tog" }, expectedProtocol: "openai-chat", expectedUrlContains: "together.xyz" },
        { id: "perplexity", env: { PERPLEXITY_API_KEY: "sk-pplx" }, expectedProtocol: "openai-chat", expectedUrlContains: "perplexity.ai" },
        { id: "vercel", env: { AI_GATEWAY_API_KEY: "sk-vcel" }, expectedProtocol: "openai-chat", expectedUrlContains: "ai-gateway.vercel.sh" },
        {
          id: "azure",
          env: { AZURE_API_KEY: "sk-az", AZURE_RESOURCE_NAME: "my-azure-res" },
          expectedUrlContains: "https://my-azure-res.openai.azure.com",
        },
        {
          id: "cloudflare-ai-gateway",
          env: { CLOUDFLARE_API_TOKEN: "sk-cf", CLOUDFLARE_ACCOUNT_ID: "acct123", CLOUDFLARE_GATEWAY_ID: "gw456" },
          expectedUrlContains: "acct123",
        },
        { id: "ollama", env: {}, expectKeyless: true },
        { id: "lmstudio", env: {}, expectedProtocol: "openai-chat", expectedUrlContains: "127.0.0.1:1234", expectKeyless: true },
        { id: "vllm", env: {}, expectedProtocol: "openai-chat", expectedUrlContains: "127.0.0.1:8000", expectKeyless: true },
      ];

      for (const c of cases) {
        const cfg = loadConfig({ HOME: home, HZ_PROVIDER: c.id, ...c.env }, cfgFile);
        expect(cfg.provider).toBe(c.id);
        if (c.expectedProtocol) expect(cfg.resolved?.protocol).toBe(c.expectedProtocol);
        if (c.expectedUrlContains) expect(cfg.baseUrl).toContain(c.expectedUrlContains);
        expect(missingKey(cfg)).toBeNull();
        if (c.expectKeyless && cfg.resolved) {
          expect(cfg.resolved.wantsKey).toBe(false);
        }
        const provider = makeProvider(cfg);
        expect(provider.name).toBe(c.id);
      }
    } finally {
      if (prev !== undefined) process.env.HZ_NO_COMMITTED_SNAPSHOT = prev;
    }
  });

  test("HZ_MODELS_PATH overrides cache and HZ_DISABLE_FREE_MODELS=1 filters free models", () => {
    const home = makeTemp("hz-path-home-");
    // Seed a user cache first to prove HZ_MODELS_PATH bypasses cache.
    writeCatalogCache(
      decodeCatalog(padV2Providers({})),
      { fetchedAt: new Date().toISOString(), source: "cache-seed" },
      home,
    );

    const dir = makeTemp("hz-local-path-");
    const localFile = path.join(dir, "custom-models.json");
    writeFileSync(
      localFile,
      JSON.stringify({
        "local-custom": {
          id: "local-custom",
          name: "Local Custom",
          protocol: "openai-chat",
          baseUrl: "https://local-custom.example.test/v1",
          models: {
            "paid-model": {
              id: "paid-model",
              limit: { context: 128000 },
              cost: { text: { input: 1.5, output: 3.0 } },
            },
            "demo:free": {
              id: "demo:free",
              limit: { context: 64000 },
              cost: { text: { input: 0, output: 0 } },
            },
            "zero-priced": {
              id: "zero-priced",
              limit: { context: 64000 },
              cost: { text: { input: 0, output: 0 } },
            },
          },
        },
      }),
      "utf8",
    );

    const withFree = loadCatalog({ HZ_MODELS_PATH: localFile }, home);
    expect(withFree.source).toBe("override");
    expect(Object.keys(withFree.providers)).toEqual(["local-custom"]);
    expect(Object.keys(withFree.providers["local-custom"]!.models).sort()).toEqual([
      "demo:free",
      "paid-model",
      "zero-priced",
    ]);

    const noFree = loadCatalog({ HZ_MODELS_PATH: localFile, HZ_DISABLE_FREE_MODELS: "1" }, home);
    expect(Object.keys(noFree.providers["local-custom"]!.models)).toEqual(["paid-model"]);
  });
});

describe("non-blocking ETag/SHA-256 boot refresh, 5m TTL, and manual /models refresh", () => {
  test("5-minute TTL short-circuit, ETag 304 no-op, SHA-256 digest no-op, and force: true bypass", async () => {
    const home = makeTemp("hz-refresh-algo-");
    const bodyV1 = JSON.stringify(padV2Providers({}));
    const catalogV1 = decodeCatalog(JSON.parse(bodyV1));
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const calls: Array<{ etag?: string }> = [];

    // 1. Cold cache -> fetches and writes cache + meta.
    const r1 = await refreshModelsCatalog({
      home,
      now: () => clock,
      fetchLive: async (_src, opts) => {
        calls.push({ etag: opts?.etag });
        return { catalog: catalogV1, notModified: false, etag: '"etag-1"', digest: "d".repeat(64) };
      },
    });
    expect(r1.status).toBe("updated");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.etag).toBeUndefined();
    const revAfterWrite = getCatalogCacheRevision();

    // 2. Within 5-minute TTL -> short-circuits with zero network calls.
    clock += DEFAULT_CATALOG_REFRESH_TTL_MS - 1_000;
    const r2 = await refreshModelsCatalog({
      home,
      now: () => clock,
      fetchLive: async () => {
        calls.push({});
        return { catalog: catalogV1, notModified: false, etag: '"etag-2"', digest: "e".repeat(64) };
      },
    });
    expect(r2.status).toBe("skipped-ttl");
    expect(calls).toHaveLength(1);
    expect(getCatalogCacheRevision()).toBe(revAfterWrite);

    // 3. After 5-minute TTL -> sends If-None-Match ETag; HTTP 304 updates meta.updatedAt only (no rewrite/rev bump).
    clock += 2_000;
    const r3 = await refreshModelsCatalog({
      home,
      now: () => clock,
      fetchLive: async (_src, opts) => {
        calls.push({ etag: opts?.etag });
        return { catalog: { providers: {}, rejected: [] }, notModified: true, etag: '"etag-1"' };
      },
    });
    expect(r3.status).toBe("not-modified");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.etag).toBe('"etag-1"');
    expect(getCatalogCacheRevision()).toBe(revAfterWrite);
    expect(readCatalogCacheMeta(home)?.updatedAt).toBe(clock);

    // 4. After another 5 minutes -> HTTP 200 with identical SHA-256 digest -> meta update only (no rewrite/rev bump).
    clock += DEFAULT_CATALOG_REFRESH_TTL_MS + 1_000;
    const r4 = await refreshModelsCatalog({
      home,
      now: () => clock,
      fetchLive: async (_src, opts) => {
        calls.push({ etag: opts?.etag });
        return { catalog: catalogV1, notModified: false, etag: '"etag-1b"', digest: "d".repeat(64) };
      },
    });
    expect(r4.status).toBe("unchanged-digest");
    expect(calls).toHaveLength(3);
    expect(getCatalogCacheRevision()).toBe(revAfterWrite);
    expect(readCatalogCacheMeta(home)?.etag).toBe('"etag-1b"');

    // 5. Manual force: true bypasses 5-minute TTL AND omits ETag -> writes cache & bumps revision.
    clock += 1_000; // still inside 5m TTL
    const r5 = await refreshModelsCatalog({
      home,
      force: true,
      now: () => clock,
      fetchLive: async (_src, opts) => {
        calls.push({ etag: opts?.etag });
        return { catalog: catalogV1, notModified: false, etag: '"etag-forced"', digest: "d".repeat(64) };
      },
    });
    expect(r5.status).toBe("updated");
    expect(calls).toHaveLength(4);
    expect(calls[3]!.etag).toBeUndefined();
    expect(getCatalogCacheRevision()).toBe(revAfterWrite + 1);
  });

  test("triggerBootCatalogRefresh is non-blocking and respects HZ_DISABLE_MODELS_FETCH and HZ_MODELS_PATH", async () => {
    let called = false;
    triggerBootCatalogRefresh({
      env: { HZ_DISABLE_MODELS_FETCH: "1" },
      fetchLive: async () => {
        called = true;
        return { catalog: { providers: {}, rejected: [] }, notModified: true };
      },
    });
    triggerBootCatalogRefresh({
      env: { HZ_MODELS_PATH: "/tmp/local.json" },
      fetchLive: async () => {
        called = true;
        return { catalog: { providers: {}, rejected: [] }, notModified: true };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(false);

    // Non-blocking boot refresh returns void synchronously while fetch completes asynchronously.
    const home = makeTemp("hz-boot-refresh-");
    let finished = false;
    const ret = triggerBootCatalogRefresh({
      home,
      env: {},
      fetchLive: async () => {
        await new Promise((r) => setTimeout(r, 15));
        finished = true;
        return { catalog: decodeCatalog(padV2Providers({})), notModified: false, etag: '"boot-etag"', digest: "b".repeat(64) };
      },
    });
    expect(ret).toBeUndefined();
    expect(finished).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(finished).toBe(true);
    expect(readCatalogCacheMeta(home)?.etag).toBe('"boot-etag"');
  });

  test("models-slash /models refresh executes forced refresh and formats notice", async () => {
    expect(isModelsRefreshCommand("refresh")).toBe(true);
    expect(isModelsRefreshCommand("  REFRESH ")).toBe(true);
    expect(isModelsRefreshCommand("list")).toBe(false);

    const home = makeTemp("hz-slash-refresh-");
    const seenEtags: Array<string | undefined> = [];
    const { result, notice } = await runModelsSlashRefresh({
      home,
      env: {},
      fetchLive: async (_src, opts) => {
        seenEtags.push(opts?.etag);
        return {
          catalog: decodeCatalog(padV2Providers({})),
          notModified: false,
          etag: '"slash-etag"',
          digest: "c".repeat(64),
        };
      },
    });
    expect(seenEtags).toEqual([undefined]);
    expect(result.status).toBe("updated");
    expect(notice).toContain("models catalog refreshed");
    expect(notice).toContain(`${MINIMUM_PROVIDERS} providers`);
  });
});

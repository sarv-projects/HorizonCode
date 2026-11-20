import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  catalogCachePath,
  decodeCatalog,
  getCatalogCacheRevision,
  loadCatalog,
  MINIMUM_PROVIDERS,
} from "../../src/core/catalog/catalog";
import {
  makeModelsCatalogPollCacheWriteGuard,
  makeModelsCatalogPollNetGuard,
  modelsCatalogFetchUrl,
  parseModelsPollIntervalMs,
  runModelsCatalogPollOnce,
  startModelsCatalogPoll,
} from "../../src/core/catalog/catalog-poll";
import { createRuntime } from "../../src/core/index";

describe("models catalog poll", () => {
  test("disabled unless HZ_MODELS_POLL_MS is at least 60s", () => {
    expect(parseModelsPollIntervalMs({})).toBeUndefined();
    expect(parseModelsPollIntervalMs({ HZ_MODELS_POLL_MS: "1000" })).toBeUndefined();
    expect(parseModelsPollIntervalMs({ HZ_MODELS_POLL_MS: "120000" })).toBe(120_000);
  });

  test("start returns stop without network when disabled", () => {
    const stop = startModelsCatalogPoll({ intervalMs: undefined });
    expect(typeof stop).toBe("function");
    stop();
  });

  test("makeModelsCatalogPollNetGuard fail-closed on deny and ask", async () => {
    const url = modelsCatalogFetchUrl();
    const denyGuard = makeModelsCatalogPollNetGuard(async () => ({ decision: "deny", reason: "test-deny" }));
    await expect(denyGuard(url)).rejects.toThrow(/denied/);
    const askGuard = makeModelsCatalogPollNetGuard(async () => ({ decision: "ask" }));
    await expect(askGuard(url)).rejects.toThrow(/cannot prompt/);
    const allowGuard = makeModelsCatalogPollNetGuard(async () => ({ decision: "allow" }));
    await allowGuard(url);
  });

  test("makeModelsCatalogPollCacheWriteGuard fail-closed on deny and ask (ruling 576)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-poll-cw-"));
    const target = catalogCachePath(home);
    const denyGuard = makeModelsCatalogPollCacheWriteGuard(async () => ({ decision: "deny", reason: "test-deny-cache" }), home);
    await expect(denyGuard(target)).rejects.toThrow(/denied|test-deny-cache/);
    const askGuard = makeModelsCatalogPollCacheWriteGuard(async () => ({ decision: "ask" }), home);
    await expect(askGuard(target)).rejects.toThrow(/cannot prompt/);
    const allowGuard = makeModelsCatalogPollCacheWriteGuard(async () => ({ decision: "allow" }), home);
    await allowGuard(target);
    rmSync(home, { recursive: true, force: true });
  });

  test("runModelsCatalogPollOnce refuses cache write when assertCacheWrite denies (ruling 576)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-poll-deny-write-"));
    const notices: string[] = [];
    const providers: Record<string, unknown> = {};
    for (let i = 0; i < MINIMUM_PROVIDERS; i += 1) {
      const id = `deny-p${i}`;
      const mid = `deny-m${i}`;
      providers[id] = { id, defaultModel: mid, models: { [mid]: { id: mid, provider: id, limit: { context: 128000 } } } };
    }
    await runModelsCatalogPollOnce({
      home,
      onNotice: (m) => notices.push(m),
      assertCacheWrite: async () => {
        throw new Error("fs.write denied — test-deny-cache");
      },
      fetchLive: async () => ({
        catalog: decodeCatalog({ providers }),
        notModified: false,
        etag: '"deny-write"',
      }),
    });
    expect(notices.some((n) => n.includes("poll failed") && n.includes("denied"))).toBe(true);
    expect(existsSync(catalogCachePath(home))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("runModelsCatalogPollOnce refuses fetch when assertNetFetch denies", async () => {
    const notices: string[] = [];
    let fetchCalled = false;
    await runModelsCatalogPollOnce({
      onNotice: (m) => notices.push(m),
      assertNetFetch: async () => {
        throw new Error("net.fetch denied — policy");
      },
      fetchLive: async () => {
        fetchCalled = true;
        return { catalog: { providers: {}, rejected: [] }, notModified: false };
      },
    });
    expect(fetchCalled).toBe(false);
    expect(notices.some((n) => n.includes("poll failed") && n.includes("denied"))).toBe(true);
  });

  test("runModelsCatalogPollOnce writes cache and loadCatalog reloads it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-poll-cache-"));
    const providers: Record<string, unknown> = {};
    for (let i = 0; i < MINIMUM_PROVIDERS; i += 1) {
      const id = `poll-p${i}`;
      const mid = `poll-m${i}`;
      providers[id] = { id, defaultModel: mid, models: { [mid]: { id: mid, provider: id, limit: { context: 128000 } } } };
    }
    const beforeRev = getCatalogCacheRevision();
    let updated: { revision: number; providerCount: number } | undefined;
    await runModelsCatalogPollOnce({
      home,
      onCacheUpdated: (info) => {
        updated = info;
      },
      fetchLive: async () => ({
        catalog: decodeCatalog({ providers }),
        notModified: false,
        etag: '"poll-test"',
      }),
    });
    expect(getCatalogCacheRevision()).toBeGreaterThan(beforeRev);
    expect(updated?.providerCount).toBe(MINIMUM_PROVIDERS);
    const loaded = loadCatalog({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, home);
    expect(loaded.source).toBe("cache");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("createRuntime catalog poll wire", () => {
  let workspace = "";
  const prev = process.env.HZ_MODELS_POLL_MS;
  afterEach(async () => {
    delete process.env.HZ_MODELS_POLL_MS;
    if (prev !== undefined) process.env.HZ_MODELS_POLL_MS = prev;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = "";
  });

  test("poll is off by default; enabled when HZ_MODELS_POLL_MS is set", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-poll-rt-"));
    const off = await createRuntime({ workspace, mock: true });
    await off.close();
    process.env.HZ_MODELS_POLL_MS = "120000";
    const on = await createRuntime({ workspace, mock: true });
    await on.close();
  });
});
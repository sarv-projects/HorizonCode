import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MINIMUM_PROVIDERS,
  decodeCatalog,
  fetchLiveCatalog,
  getCatalogCacheRevision,
  isCatalogCacheStale,
  readCatalogCache,
  loadCatalog,
  summarizeCatalogDiff,
  writeCatalogCache,
} from "../../src/core/catalog/catalog";

let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function fixtureProviders(n: number): unknown {
  const providers: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) {
    const id = `p${i}`;
    const mid = `m${i}`;
    providers[id] = { id, defaultModel: mid, models: { [mid]: { id: mid, provider: id, limit: { context: 128000 } } } };
  }
  return { providers };
}

describe("catalog refresh", () => {
  test("assertNetFetch runs before the fetcher", async () => {
    let guardCalled = false;
    await fetchLiveCatalog("https://example.test", {
      fetcher: async () => {
        guardCalled = true;
        return { status: 304, body: "" };
      },
      assertNetFetch: () => {
        if (guardCalled) throw new Error("guard must run before fetch");
      },
    });
    expect(guardCalled).toBe(true);
  });

  test("304 leaves cache semantics", async () => {
    const res = await fetchLiveCatalog("https://example.test", {
      etag: '"abc"',
      fetcher: async () => ({ status: 304, body: "" }),
    });
    expect(res.notModified).toBe(true);
  });

  test("writeCatalogCache bumps catalogCacheRevision", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-rev-"));
    const before = getCatalogCacheRevision();
    writeCatalogCache(decodeCatalog(fixtureProviders(MINIMUM_PROVIDERS)), { fetchedAt: new Date().toISOString(), source: "test" }, home);
    expect(getCatalogCacheRevision()).toBe(before + 1);
  });

  test("loadCatalog prefers user cache over curated", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-home-"));
    const body = fixtureProviders(MINIMUM_PROVIDERS);
    const catalog = decodeCatalog(body);
    writeCatalogCache(catalog, { fetchedAt: new Date().toISOString(), source: "test" }, home);
    const loaded = loadCatalog({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, home);
    expect(loaded.source).toBe("cache");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS);
  });

  test("user cache wins over committed snapshot when both exist", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-home-"));
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cat-snap-"));
    const snapFile = path.join(dir, "models-dev.snapshot.json");
    const cacheBody = fixtureProviders(MINIMUM_PROVIDERS);
    const snapBody = fixtureProviders(MINIMUM_PROVIDERS + 5);
    writeCatalogCache(decodeCatalog(cacheBody), { fetchedAt: new Date().toISOString(), source: "test" }, home);
    writeFileSync(snapFile, JSON.stringify(snapBody), "utf8");
    const loaded = loadCatalog({ HZ_MODELS_COMMITTED_SNAPSHOT: snapFile, HZ_NO_COMMITTED_SNAPSHOT: "0" }, home);
    expect(loaded.source).toBe("cache");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS);
    rmSync(dir, { recursive: true, force: true });
  });

  test("committed snapshot is used when no user cache exists", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-home-"));
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cat-snap-"));
    const snapFile = path.join(dir, "models-dev.snapshot.json");
    const snapBody = fixtureProviders(MINIMUM_PROVIDERS + 2);
    writeFileSync(snapFile, JSON.stringify(snapBody), "utf8");
    const loaded = loadCatalog({ HZ_MODELS_COMMITTED_SNAPSHOT: snapFile, HZ_NO_COMMITTED_SNAPSHOT: "0" }, home);
    expect(loaded.source).toBe("snapshot");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS + 2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("summarizeCatalogDiff names provider and model counts", () => {
    const a = decodeCatalog(fixtureProviders(2));
    const b = decodeCatalog(fixtureProviders(3));
    const line = summarizeCatalogDiff(a, b);
    expect(line).toContain("providers 2→3");
    expect(line).toContain("+providers:");
  });
});


describe("catalog cache digest + TTL (explicit refresh only)", () => {
  test("fetchLiveCatalog returns the body digest on a 200", async () => {
    const body = JSON.stringify(fixtureProviders(MINIMUM_PROVIDERS));
    const res = await fetchLiveCatalog("https://example.test", {
      fetcher: async () => ({ status: 200, body, etag: '"v2"' }),
    });
    expect(res.notModified).toBe(false);
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.etag).toBe('"v2"');
  });

  test("isCatalogCacheStale is pure and never triggers a fetch", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(isCatalogCacheStale({ fetchedAt: "2026-11-17T11:58:00Z" }, now)).toBe(false);
    expect(isCatalogCacheStale({ fetchedAt: "2026-11-17T11:50:00Z" }, now)).toBe(true);
    expect(isCatalogCacheStale(undefined, now)).toBe(true);
    expect(isCatalogCacheStale({ fetchedAt: "not-a-date" }, now)).toBe(true);
  });

  test("writeCatalogCache round-trips the digest", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-digest-"));
    const digest = "a".repeat(64);
    writeCatalogCache(
      decodeCatalog(fixtureProviders(MINIMUM_PROVIDERS)),
      { fetchedAt: new Date().toISOString(), source: "test", digest },
      home,
    );
    expect(readCatalogCache(home)?.meta.digest).toBe(digest);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MINIMUM_PROVIDERS,
  decodeCatalog,
  fetchLiveCatalog,
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

  test("loadCatalog prefers user cache over curated", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-home-"));
    const body = fixtureProviders(MINIMUM_PROVIDERS);
    const catalog = decodeCatalog(body);
    writeCatalogCache(catalog, { fetchedAt: new Date().toISOString(), source: "test" }, home);
    const loaded = loadCatalog({ HZ_NO_COMMITTED_SNAPSHOT: "1" }, home);
    expect(loaded.source).toBe("cache");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS);
  });

  test("committed snapshot wins over user cache when present", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-cat-home-"));
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cat-snap-"));
    const snapFile = path.join(dir, "models-dev.snapshot.json");
    const cacheBody = fixtureProviders(MINIMUM_PROVIDERS);
    const snapBody = fixtureProviders(MINIMUM_PROVIDERS + 5);
    writeCatalogCache(decodeCatalog(cacheBody), { fetchedAt: new Date().toISOString(), source: "test" }, home);
    writeFileSync(snapFile, JSON.stringify(snapBody), "utf8");
    const loaded = loadCatalog({ HZ_MODELS_COMMITTED_SNAPSHOT: snapFile, HZ_NO_COMMITTED_SNAPSHOT: "0" }, home);
    expect(loaded.source).toBe("snapshot");
    expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS + 5);
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

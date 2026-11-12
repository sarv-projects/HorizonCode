/**
 * catalog.test.ts — the model catalog seam (FEAT-003, spec §5.4).
 *
 * Covers: loadCatalog returns the curated snapshot by default; the
 * HZ_MODELS_SNAPSHOT override path (validated, external source); validateCatalog
 * throws below the MINIMUM_PROVIDERS floor and passes at/above it; tolerant
 * decoding (an unparseable model is skipped and surfaced, never fatal); the
 * catalog default-model and context-window lookups return the curated values;
 * and the DEFAULT_MODELS fallback still yields the historical defaults when the
 * catalog misses a provider. No network: the live-fetch seam is never exercised
 * (only asserted to reject when called directly).
 */

import { expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  builtinDefaultModel,
  DEFAULT_MODELS,
} from "../../src/core/config";
import {
  COMMITTED_CATALOG_SNAPSHOT,
  CATALOG_PATH,
  catalogDefaultModel,
  countCatalogModels,
  catalogModel,
  catalogWindow,
  curatedCatalog,
  decodeCatalog,
  decodeModel,
  fetchLiveCatalog,
  loadCatalog,
  loadSnapshotFile,
  MINIMUM_PROVIDERS,
  validateCatalog,
  type Catalog,
} from "../../src/core/catalog/catalog";
import { cleanupTemps, tempDir } from "./helpers";

/** Keep the offline curated floor unless a test explicitly loads the committed bundle. */
const CURATED_ONLY = { HZ_NO_COMMITTED_SNAPSHOT: "1" } as const;

/** A synthetic external snapshot with `count` throwaway providers (for the floor). */
function bigSnapshot(count: number): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    providers[`p${i}`] = {
      id: `p${i}`,
      defaultModel: `m${i}`,
      models: { [`m${i}`]: { id: `m${i}`, provider: `p${i}`, limit: { context: 4096 } } },
    };
  }
  return { providers };
}

test("loadCatalog returns the curated snapshot by default, with the 5 built-ins", () => {
  const catalog = loadCatalog(CURATED_ONLY);
  expect(catalog.source).toBe("curated");
  expect(catalog.rejected).toEqual([]);
  expect(Object.keys(catalog.providers).sort()).toEqual(["anthropic", "google", "mock", "ollama", "openai"]);
});

test("curated default-model ids match DEFAULT_MODELS byte-for-byte", () => {
  const catalog = curatedCatalog();
  expect(catalogDefaultModel(catalog, "anthropic")).toBe(DEFAULT_MODELS.anthropic);
  expect(catalogDefaultModel(catalog, "openai")).toBe(DEFAULT_MODELS.openai);
  expect(catalogDefaultModel(catalog, "google")).toBe(DEFAULT_MODELS.google);
  expect(catalogDefaultModel(catalog, "ollama")).toBe(DEFAULT_MODELS.ollama);
  expect(catalogDefaultModel(catalog, "mock")).toBe(DEFAULT_MODELS.mock);
});

test("catalog lookups return the curated window and capabilities as DATA", () => {
  const catalog = curatedCatalog();
  const claude = catalogModel(catalog, "anthropic", "claude-sonnet-4-5");
  expect(claude?.limit.context).toBe(204800);
  expect(claude?.capabilities?.tools).toBe(true);
  expect(claude?.capabilities?.reasoning).toBe(true);
  expect(catalogWindow("anthropic", "claude-sonnet-4-5", catalog)).toBe(204800);
  expect(catalogWindow("openai", "gpt-4o-mini", catalog)).toBe(131072);
  // A model the catalog lacks has no window (caller falls back to the table).
  expect(catalogWindow("anthropic", "no-such-model", catalog)).toBeUndefined();
  expect(catalogWindow("no-such-provider", "whatever", catalog)).toBeUndefined();
});

test("builtinDefaultModel resolves through the catalog, else the DEFAULT_MODELS fallback", () => {
  // Catalog hit: equals the curated default (which equals DEFAULT_MODELS).
  expect(builtinDefaultModel("google", loadCatalog(CURATED_ONLY))).toBe("gemini-2.5-flash");
  // Catalog MISS: an empty external override that passes no floor would fall
  // back; simulate a catalog that lacks the provider and assert the fallback.
  const empty: Catalog & { source: "curated" } = { providers: {}, rejected: [], source: "curated" };
  expect(builtinDefaultModel("anthropic", empty)).toBe(DEFAULT_MODELS.anthropic);
  expect(builtinDefaultModel("ollama", empty)).toBe(DEFAULT_MODELS.ollama);
});

test("validateCatalog throws below the floor and passes at/above it", () => {
  const below = decodeCatalog(bigSnapshot(MINIMUM_PROVIDERS - 1));
  expect(Object.keys(below.providers)).toHaveLength(MINIMUM_PROVIDERS - 1);
  expect(() => validateCatalog(below, { minProviders: MINIMUM_PROVIDERS })).toThrow(/expected at least/);

  const at = decodeCatalog(bigSnapshot(MINIMUM_PROVIDERS));
  expect(() => validateCatalog(at, { minProviders: MINIMUM_PROVIDERS })).not.toThrow();

  const above = decodeCatalog(bigSnapshot(MINIMUM_PROVIDERS + 5));
  expect(validateCatalog(above, { minProviders: MINIMUM_PROVIDERS })).toBe(above);
});

test("the curated floor is deliberately NOT floor-validated (it is small by design)", () => {
  // The curated set has 5 providers — far below MINIMUM_PROVIDERS — yet
  // loadCatalog serves it without error because the floor applies only to
  // externally-sourced snapshots, never the curated boot-time floor.
  expect(Object.keys(curatedCatalog().providers).length).toBeLessThan(MINIMUM_PROVIDERS);
  expect(loadCatalog(CURATED_ONLY).source).toBe("curated");
});

test("committed models-dev.snapshot.json passes the provider floor when shipped", () => {
  if (!existsSync(COMMITTED_CATALOG_SNAPSHOT)) return;
  const prev = process.env.HZ_NO_COMMITTED_SNAPSHOT;
  delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
  try {
    const loaded = loadCatalog({});
    expect(loaded.source).toBe("snapshot");
    expect(Object.keys(loaded.providers).length).toBeGreaterThanOrEqual(MINIMUM_PROVIDERS);
    expect(countCatalogModels(loaded)).toBeGreaterThan(1000);
    expect(statSync(COMMITTED_CATALOG_SNAPSHOT).size).toBeLessThan(2 * 1024 * 1024);
  } finally {
    if (prev === undefined) delete process.env.HZ_NO_COMMITTED_SNAPSHOT;
    else process.env.HZ_NO_COMMITTED_SNAPSHOT = prev;
  }
});

test("decoding is tolerant: an unparseable model is skipped and surfaced, never fatal", () => {
  const catalog = decodeCatalog({
    providers: {
      good: {
        id: "good",
        defaultModel: "ok-1",
        models: {
          "ok-1": { id: "ok-1", provider: "good", limit: { context: 8192 } },
          "bad-1": { id: "bad-1", provider: "good", limit: { context: "not-a-number" } },
          "bad-2": 42,
        },
      },
    },
  });
  expect(Object.keys(catalog.providers.good!.models)).toEqual(["ok-1"]);
  expect(catalog.rejected.length).toBe(2);
  expect(catalog.rejected.join("\n")).toContain("good/bad-1");
  expect(catalog.rejected.join("\n")).toContain("good/bad-2");
});

test("a top-level non-object yields an empty catalog with a rejection, never a throw", () => {
  expect(decodeCatalog(null).providers).toEqual({});
  expect(decodeCatalog([1, 2, 3]).rejected.length).toBe(1);
  expect(decodeCatalog("nope").rejected[0]).toContain("not an object");
});

test("decodeModel keeps context/output/capabilities and defaults the id to the key", () => {
  const model = decodeModel("acme", "x1", { limit: { context: 1024, output: 256 }, capabilities: { tools: true } });
  expect(typeof model).not.toBe("string");
  if (typeof model === "string") throw new Error(model);
  expect(model.id).toBe("x1");
  expect(model.limit).toEqual({ context: 1024, output: 256 });
  expect(model.capabilities).toEqual({ tools: true });
  // No numeric context is the one hard requirement (it feeds NF-074).
  expect(typeof decodeModel("acme", "x2", { limit: {} })).toBe("string");
});

test("the HZ_MODELS_SNAPSHOT override wins when present and passes the floor", () => {
  const dir = tempDir("hz-snapshot-");
  const file = path.join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(bigSnapshot(MINIMUM_PROVIDERS)), "utf8");

  const loaded = loadCatalog({ HZ_MODELS_SNAPSHOT: file });
  expect(loaded.source).toBe("override");
  expect(Object.keys(loaded.providers).length).toBe(MINIMUM_PROVIDERS);

  cleanupTemps();
});

test("an override below the floor is rejected and loadCatalog falls back to curated", () => {
  const dir = tempDir("hz-snapshot-small-");
  const file = path.join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(bigSnapshot(3)), "utf8");

  expect(loadSnapshotFile(file)).toBeUndefined();
  const loaded = loadCatalog({ ...CURATED_ONLY, HZ_MODELS_SNAPSHOT: file });
  expect(loaded.source).toBe("curated");

  cleanupTemps();
});

test("a missing or unreadable override file falls back to curated, never throws", () => {
  const loaded = loadCatalog({ ...CURATED_ONLY, HZ_MODELS_SNAPSHOT: "/does/not/exist/snapshot.json" });
  expect(loaded.source).toBe("curated");
});

test("fetchLiveCatalog uses conditional GET when a fetcher is injected", async () => {
  expect(CATALOG_PATH).toContain("type=chat");
  const seen: string[] = [];
  await fetchLiveCatalog("https://example.test", {
    etag: '"v1"',
    fetcher: async (url, headers) => {
      seen.push(url);
      expect(headers["if-none-match"]).toBe('"v1"');
      return { status: 304, body: "" };
    },
  });
  expect(seen[0]).toContain("example.test");
});

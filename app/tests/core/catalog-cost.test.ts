/**
 * catalog-cost.test.ts — catalog-driven cost rates (models.dev v1) with an
 * honest priceTableRevision and a hardcoded-table fallback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { decodeModel, type Catalog } from "../../src/core/catalog/catalog";
import {
  catalogPriceTableRevision,
  estimateStepCostUsd,
  HARNESS_PRICE_TABLE_REVISION,
  ratesForModelFromCatalog,
  resolveRates,
  setCostCatalog,
  usageCostEventFields,
} from "../../src/core/usage-cost";

afterEach(() => setCostCatalog(undefined));

function catalogWith(modelId: string, cost: Record<string, unknown>): Catalog {
  const model = decodeModel("nvidia", modelId, {
    id: modelId,
    limit: { context: 128_000 },
    cost,
  });
  if (typeof model === "string") throw new Error(model);
  return {
    providers: {
      nvidia: { id: "nvidia", defaultModel: modelId, models: { [modelId]: model } },
    },
    rejected: [],
  };
}

describe("catalog-driven cost", () => {
  test("decodeModel reads v1 cache_read / cache_write / tiers", () => {
    const model = decodeModel("openai", "gpt-x", {
      id: "gpt-x",
      limit: { context: 200_000 },
      cost: {
        input: 1,
        output: 2,
        cache_read: 0.1,
        cache_write: 1.5,
        tiers: [
          { input: 3, output: 4, cache_read: 0.3, tier: { type: "context", size: 272_000 } },
        ],
        context_over_200k: { input: 5, output: 6 },
      },
    });
    if (typeof model === "string") throw new Error(model);
    expect(model.cost).toEqual({
      input: 1,
      output: 2,
      cacheReadPerM: 0.1,
      cacheWritePerM: 1.5,
      tiers: [
        { size: 272_000, input: 3, output: 4, cacheReadPerM: 0.3 },
        { size: 200_000, input: 5, output: 6 },
      ],
    });
  });

  test("catalog rates win; an explicit zero price is honored (NVIDIA)", () => {
    const catalog = catalogWith("deepseek-ai/deepseek-v4.1-flash", { input: 0, output: 0 });
    expect(ratesForModelFromCatalog(catalog, "nvidia", "deepseek-ai/deepseek-v4.1-flash")).toEqual({
      inputPerM: 0,
      outputPerM: 0,
      cacheReadPerM: undefined,
      cacheWritePerM: undefined,
    });
    const fields = usageCostEventFields(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "nvidia",
      "deepseek-ai/deepseek-v4.1-flash",
      catalog,
    );
    expect(fields).toEqual({
      costMicroUsd: 0,
      currency: "USD",
      priceTableRevision: catalogPriceTableRevision("nvidia", "deepseek-ai/deepseek-v4.1-flash"),
    });
    expect(estimateStepCostUsd(1_000_000, 1_000_000, "nvidia", "deepseek-ai/deepseek-v4.1-flash", catalog)).toBe(0);
  });

  test("cache rates from the catalog are merged with the harness fallback", () => {
    const catalog = catalogWith("m", { input: 1, output: 2, cache_read: 0.25 });
    const resolved = resolveRates("nvidia", "m", catalog);
    expect(resolved.revision).toBe(catalogPriceTableRevision("nvidia", "m"));
    expect(resolved.rates.inputPerM).toBe(1);
    expect(resolved.rates.cacheReadPerM).toBe(0.25);
    // cacheWritePerM absent in the catalog -> harness default (3.75).
    expect(resolved.rates.cacheWritePerM).toBe(3.75);
  });

  test("context tier overrides the base price when tokens are known", () => {
    const catalog = catalogWith("m", {
      input: 1,
      output: 2,
      tiers: [{ input: 4, output: 5, tier: { type: "context", size: 200_000 } }],
    });
    expect(ratesForModelFromCatalog(catalog, "nvidia", "m", 250_000)).toMatchObject({ inputPerM: 4, outputPerM: 5 });
    expect(ratesForModelFromCatalog(catalog, "nvidia", "m", 100_000)).toMatchObject({ inputPerM: 1, outputPerM: 2 });
  });

  test("unknown model falls back to the hardcoded table and honest revision", () => {
    const catalog = catalogWith("known", { input: 0, output: 0 });
    const fields = usageCostEventFields({ inputTokens: 1_000_000 }, "anthropic", "claude-unknown", catalog);
    expect(fields).toEqual({
      costMicroUsd: 3_000_000,
      currency: "USD",
      priceTableRevision: HARNESS_PRICE_TABLE_REVISION,
    });
  });

  test("registered catalog seam drives the estimate without threading an argument", () => {
    setCostCatalog(catalogWith("m", { input: 0, output: 0 }));
    expect(estimateStepCostUsd(1_000_000, 0, "nvidia", "m")).toBe(0);
    expect(usageCostEventFields({ inputTokens: 1_000_000 }, "nvidia", "m")?.priceTableRevision).toBe(
      catalogPriceTableRevision("nvidia", "m"),
    );
  });
});

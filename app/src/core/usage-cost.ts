/**
 * H-2 reduced (docs/30): cache-write / cache-read token fields and a rough USD
 * estimate when adapters expose usage (ADAPT aider cost accounting).
 *
 * ADDITIVE: when a models.dev catalog is supplied (or registered), its v1 cost
 * data wins per-field over the historical hardcoded table. An explicit `0` in
 * the catalog (e.g. many NVIDIA-hosted models) is honored — it is a real price,
 * not a missing value. `priceTableRevision` says which source produced the
 * estimate so a harness guess is never mistaken for catalog data.
 */

import type { Usage } from "../contracts";
import type { Catalog } from "./catalog/catalog";

export interface UsageCostBreakdown {
  inputUsd?: number;
  outputUsd?: number;
  cacheWriteUsd?: number;
  cacheReadUsd?: number;
  totalUsd?: number;
}

/** Per-1M-token rates (harness estimates, not billing truth). */
export interface ModelRateTable {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM?: number;
  cacheReadPerM?: number;
}

const DEFAULT_RATES: ModelRateTable = {
  inputPerM: 3,
  outputPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
};

export function ratesForModel(provider: string, model: string): ModelRateTable {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (p === "anthropic" || m.includes("claude")) return DEFAULT_RATES;
  if (p === "openai" || m.includes("gpt")) {
    return { inputPerM: 2.5, outputPerM: 10, cacheWritePerM: 2.5, cacheReadPerM: 1.25 };
  }
  return DEFAULT_RATES;
}

/** Harness estimate table id on `hz.usage.recorded` (not provider invoice truth). */
export const HARNESS_PRICE_TABLE_REVISION = "harness-v1";

/** Revision tag for a catalog-sourced estimate. */
export function catalogPriceTableRevision(provider: string, model: string): string {
  return `models.dev-v1:${provider}/${model}`;
}

/**
 * Optional process-local catalog seam (no dynamic import, no new dependency).
 * Callers that cannot thread a `Catalog` argument through their call chain can
 * register it once at boot; explicit arguments always win. Default is unset so
 * existing behavior is byte-for-byte unchanged until an integrator opts in.
 */
let registeredCatalog: Catalog | undefined;
export function setCostCatalog(catalog: Catalog | undefined): void {
  registeredCatalog = catalog;
}
export function getCostCatalog(): Catalog | undefined {
  return registeredCatalog;
}

/**
 * Pure catalog resolver: rates for `(provider, model)` from a decoded catalog,
 * or `undefined` when the catalog has no priced model here. Explicit `0` is a
 * valid price and is returned as-is. When `contextTokens` is given, the largest
 * applicable v1 context tier overrides the base price field by field.
 *
 * HOOKUP POINT: mirrors `catalogWindow`'s integrator-fenced pattern. Production
 * callers pass a catalog to `usageCostEventFields` / `estimateStepCostUsd`, or
 * register one with `setCostCatalog`; the hardcoded table stays the fallback.
 */
export function ratesForModelFromCatalog(
  catalog: Catalog | undefined,
  provider: string,
  model: string,
  contextTokens?: number,
): ModelRateTable | undefined {
  if (!catalog) return undefined;
  const cost = catalog.providers[provider]?.models[model]?.cost;
  if (!cost || cost.input === undefined || cost.output === undefined) return undefined;
  let tier: (typeof cost.tiers)[number] | undefined;
  if (Number.isFinite(contextTokens) && Array.isArray(cost.tiers)) {
    for (const candidate of cost.tiers) {
      if (contextTokens! >= candidate.size && (tier === undefined || candidate.size > tier.size)) tier = candidate;
    }
  }
  return {
    inputPerM: tier?.input ?? cost.input,
    outputPerM: tier?.output ?? cost.output,
    cacheReadPerM: tier?.cacheReadPerM ?? cost.cacheReadPerM,
    cacheWritePerM: tier?.cacheWritePerM ?? cost.cacheWritePerM,
  };
}

/** Resolve rates plus the honest revision id for one model. */
export function resolveRates(
  provider: string,
  model: string,
  catalog?: Catalog,
  contextTokens?: number,
): { rates: ModelRateTable; revision: string } {
  const fromCatalog = ratesForModelFromCatalog(catalog ?? registeredCatalog, provider, model, contextTokens);
  if (fromCatalog) {
    return {
      rates: {
        inputPerM: fromCatalog.inputPerM,
        outputPerM: fromCatalog.outputPerM,
        cacheReadPerM: fromCatalog.cacheReadPerM ?? 0,
        cacheWritePerM: fromCatalog.cacheWritePerM ?? 0,
      },
      revision: catalogPriceTableRevision(provider, model),
    };
  }
  return { rates: ratesForModel(provider, model), revision: HARNESS_PRICE_TABLE_REVISION };
}

export interface UsageCostEventFields {
  /** Integer micro-USD of the total estimate (`Math.round(totalUsd * 1e6)`). */
  costMicroUsd: number;
  currency: "USD";
  /** Which table produced the estimate: `harness-v1` or `models.dev-v1:<provider>/<model>`. */
  priceTableRevision: string;
}

/**
 * Reduced H-2 / RC-18 fields for `hz.usage.recorded`: harness/catalog estimate
 * only. Live provider billing / invoice reconciliation remains OPEN.
 */
export function usageCostEventFields(
  usage: Usage,
  provider: string,
  model: string,
  catalog?: Catalog,
): UsageCostEventFields | undefined {
  const { rates, revision } = resolveRates(provider, model, catalog);
  // A catalog can legitimately price a model at $0 (e.g. many NVIDIA-hosted
  // models). Force the cost object so the revision and the zero estimate stay
  // honest; `enrichUsageCostWithRates` still omits when no token count is present.
  const total = enrichUsageCostWithRates(usage, rates, true).cost?.totalUsd;
  if (total === undefined) return undefined;
  return {
    costMicroUsd: Math.round(total * 1_000_000),
    currency: "USD",
    priceTableRevision: revision,
  };
}

/**
 * Worst-case USD estimate for one provider step, used by the workspace-wide
 * SpendLedger reservation (backlog C-5). `inputTokens` is the prompt estimate
 * and `outputTokens` the fitted output cap; the rate table is the same harness
 * estimate the usage event publishes, never a billing claim.
 */
export function estimateStepCostUsd(
  inputTokens: number,
  outputTokens: number,
  provider: string,
  model: string,
  catalog?: Catalog,
): number {
  const { rates } = resolveRates(provider, model, catalog);
  const input = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const output = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  return (input / 1_000_000) * rates.inputPerM + (output / 1_000_000) * rates.outputPerM;
}

export function enrichUsageCost(usage: Usage, provider: string, model: string, catalog?: Catalog): Usage & { cost?: UsageCostBreakdown } {
  const { rates } = resolveRates(provider, model, catalog);
  return enrichUsageCostWithRates(usage, rates);
}

function enrichUsageCostWithRates(
  usage: Usage,
  rates: ModelRateTable,
  forceCost = false,
): Usage & { cost?: UsageCostBreakdown } {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const nonCached = usage.nonCachedInputTokens;
  const hasTokens = input > 0 || output > 0 || cacheWrite > 0 || cacheRead > 0 || (nonCached ?? 0) > 0;
  const billableInput =
    nonCached !== undefined ? Math.max(0, nonCached) : Math.max(0, input - cacheWrite - cacheRead);

  const inputUsd = (billableInput / 1_000_000) * rates.inputPerM;
  const outputUsd = (output / 1_000_000) * rates.outputPerM;
  const cacheWriteUsd =
    cacheWrite > 0 ? (cacheWrite / 1_000_000) * (rates.cacheWritePerM ?? rates.inputPerM * 1.25) : 0;
  const cacheReadUsd = cacheRead > 0 ? (cacheRead / 1_000_000) * (rates.cacheReadPerM ?? rates.inputPerM * 0.1) : 0;
  const totalUsd = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd;

  const out: Usage & { cost?: UsageCostBreakdown } = { ...usage };
  if (forceCost ? hasTokens : totalUsd > 0 || cacheWrite > 0 || cacheRead > 0) {
    out.cost = {
      inputUsd: inputUsd || undefined,
      outputUsd: outputUsd || undefined,
      cacheWriteUsd: cacheWriteUsd || undefined,
      cacheReadUsd: cacheReadUsd || undefined,
      totalUsd: forceCost ? totalUsd : totalUsd || undefined,
    };
  }
  return out;
}

/**
 * catalog.ts — the model catalog seam (spec research/compare-providers.md §5.4).
 *
 * HorizonCode's catalog today is `DEFAULT_MODELS` in config.ts: five hardcoded
 * strings. opencode instead relies on a models.dev snapshot (230 providers /
 * 8787 models, packages/core/src/models-dev.ts), validated at build with a
 * `MINIMUM_PROVIDERS = 100` floor. This module ports the SHAPE and the SEAM of
 * that design, reduced to the fields HorizonCode actually reads, so a later PR
 * can swap the data source without touching callers.
 *
 * What lands here:
 *  - A reduced catalog record mirroring opencode's normalized shape: per model
 *    `{ id, provider, limit: { context, output? }, capabilities?, cost? }` and
 *    per provider a default model id.
 *  - TOLERANT decoding (mirrors opencode's `normalize()`): an unparseable model
 *    is SKIPPED and collected in `rejected`, never fatal. A whole catalog that
 *    is not even an object yields an empty catalog with one rejection line.
 *  - `loadCatalog()` precedence (docs/33 §5.8):
 *      (1) `HZ_MODELS_SNAPSHOT` env file when valid (floor-validated);
 *      (2) user cache from `hzcode models refresh` / background poll;
 *      (3) committed `models-dev.snapshot.json` when shipped;
 *      (4) curated offline floor;
 *      Live fetch (`fetchLiveCatalog`) is explicit-only (refresh/poll), never
 *      implicit on boot.
 *  - `validateCatalog(catalog, { minProviders })`: throws below the floor.
 *
 * DELIBERATE DEFERRAL (documented in docs/28): the full ~8 MB models.dev
 * snapshot bundle and the live refresh (ETag/digest, 5-minute poll) opencode
 * ships are OUT OF SCOPE for this PR — too heavy for review and unavailable
 * under the no-network sandbox. The curated set + the seam + the floor concept
 * land now; `fetchLiveCatalog` marks exactly where the refresh hooks in.
 *
 * MINIMUM_PROVIDERS decision: opencode's floor "is a floor, not equality:
 * guards against an error page or a truncated body that still parses as a small
 * object." That guard only makes sense for an EXTERNALLY-sourced snapshot (the
 * env override or a live fetch), which is expected to be the full catalog. The
 * committed curated set is DELIBERATELY small (5 providers), so applying the
 * floor to it would reject our own boot-time floor. Therefore the floor is
 * applied ONLY on the override/fetch paths, never to the curated snapshot.
 *
 * DOCTRINE (spec §2 "model/provider policy is DATA, never id.includes('claude')
 * in code"): capabilities and limits are READ from the catalog record. There is
 * no model-name string matching in this module.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../canon";
import { userConfigDir } from "../paths";
import curatedSnapshot from "./models-dev.curated.json";
import { metricContract } from "../metrics";
import {
  isV1Catalog,
  mapProtocolIdentifier,
  normalizeSdkPackageName,
  normalizeV1ToV2,
  resolveApiRoute,
  SUPPORTED_CATALOG_PROTOCOLS,
  type CatalogProviderProtocol,
  type ResolvedApiRoute,
} from "./v1-to-v2";

export {
  isV1Catalog,
  mapProtocolIdentifier,
  normalizeSdkPackageName,
  normalizeV1ToV2,
  resolveApiRoute,
  SUPPORTED_CATALOG_PROTOCOLS,
  type CatalogProviderProtocol,
  type ResolvedApiRoute,
};

/** opencode's build-time floor (packages/core/script/models-snapshot.ts). */
export const MINIMUM_PROVIDERS = 100;

/**
 * The v2 experimental models.dev API (matches OpenCode `ModelsDev.catalogPath`),
 * fetched from `https://models.opencode.ai`, `HZ_MODELS_URL`, or models.dev directly.
 */
export const CATALOG_PATH = "/experimental/v2.0/api.json?type=chat,decision,image";
/** Legacy models.dev v1 endpoint used as a 404 fallback on custom v1 mirrors. */
export const CATALOG_V1_PATH = "/api.json";
export const DEFAULT_CATALOG_SOURCE = "https://models.opencode.ai";

/** True when `HZ_DISABLE_MODELS_FETCH` airgap kill-switch is active. */
export function isModelsFetchDisabled(env: CatalogEnv = process.env): boolean {
  const raw = typeof env.HZ_DISABLE_MODELS_FETCH === "string" ? env.HZ_DISABLE_MODELS_FETCH.trim().toLowerCase() : "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** True when `HZ_DISABLE_FREE_MODELS` is active (filters `:free` / zero-cost models). */
export function isFreeModelsDisabled(env: CatalogEnv = process.env): boolean {
  const raw = typeof env.HZ_DISABLE_FREE_MODELS === "string" ? env.HZ_DISABLE_FREE_MODELS.trim().toLowerCase() : "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Local catalog file override (`HZ_MODELS_PATH`), bypassing cache and network fetch. */
export function resolveModelsPath(env: CatalogEnv = process.env): string | undefined {
  const raw = typeof env.HZ_MODELS_PATH === "string" ? env.HZ_MODELS_PATH.trim() : "";
  return raw !== "" ? raw : undefined;
}

/** Resolve the effective catalog source URL (`source` arg → `HZ_MODELS_URL` → default). */
export function resolveCatalogSource(source?: string, env: CatalogEnv = process.env): string {
  const explicit = typeof source === "string" ? source.trim() : "";
  if (explicit !== "") return explicit;
  const fromEnv = typeof env.HZ_MODELS_URL === "string" ? env.HZ_MODELS_URL.trim() : "";
  if (fromEnv !== "") return fromEnv;
  return DEFAULT_CATALOG_SOURCE;
}

/** One context-size price tier from models.dev v1 tiers or v2 cost.text.overrides. */
export interface ModelCostTier {
  /** Context size (tokens) at/above which this tier applies. */
  size: number;
  input?: number;
  output?: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** Per-token cost in USD per million tokens; a reduced slice of models.dev. */
export interface ModelCost {
  input?: number;
  output?: number;
  /** v1 `cost.cache_read` / v2 `cost.text.cache_read` (USD / 1M tokens). */
  cacheReadPerM?: number;
  /** v1 `cost.cache_write` / v2 `cost.text.cache_write` (USD / 1M tokens). */
  cacheWritePerM?: number;
  /** Optional context-size price overrides (v1 `cost.tiers` / v2 `cost.text.overrides`). */
  tiers?: ModelCostTier[];
}

/** Effective per-token cost resolved for a model (optionally at a prompt token tier). */
export interface ResolvedModelCost {
  input?: number;
  output?: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  tierSize?: number;
}

/** Structured reasoning options from models.dev v2 `capabilities.reasoning`. */
export interface ModelReasoningOptions {
  toggle?: boolean;
  effort?: string[] | boolean;
  budget?: { min?: number; max?: number; default?: number } | boolean;
  interleaved?: boolean | { field: string };
}

/** The capabilities HorizonCode reads — DATA, never inferred from the id. */
export interface ModelCapabilities {
  tools?: boolean;
  reasoning?: boolean;
  reasoningOptions?: ModelReasoningOptions;
  temperature?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  cacheControl?: boolean;
}

/** Input/output modalities declared by models.dev (e.g. `["text", "image"]`). */
export interface ModelModalities {
  input?: string[];
  output?: string[];
}

/** One catalog model, the normalized shape (opencode `Model.Info`). */
export interface CatalogModel {
  id: string;
  provider: string;
  type?: string;
  name?: string;
  family?: string;
  status?: string;
  releasedAt?: string;
  modalities?: ModelModalities;
  protocol?: CatalogProviderProtocol;
  baseUrl?: string;
  headers?: Record<string, string>;
  compatibility?: Record<string, unknown>;
  limit: { context: number; output?: number };
  capabilities?: ModelCapabilities;
  cost?: ModelCost;
  /**
   * H-1: optional provider params this model accepts (aider `accepts_settings`).
   * Present (including `[]`) wins over capability derivation in
   * `resolveCatalogAcceptsSettings`.
   */
  acceptsSettings?: string[];
}

/** One catalog provider: its metadata, default model id, and its models by id. */
export interface CatalogProvider {
  id: string;
  name?: string;
  env?: string[];
  baseUrl?: string;
  protocol?: CatalogProviderProtocol;
  defaultModel: string;
  models: Record<string, CatalogModel>;
}

/** The decoded catalog plus the tolerant-decode rejections (never thrown). */
export interface Catalog {
  providers: Record<string, CatalogProvider>;
  /** One readable line per model/provider entry that was skipped (not fatal). */
  rejected: string[];
}

/** Where a loaded catalog came from, for the banner and for debugging. */
export type CatalogSource = "override" | "snapshot" | "cache" | "curated" | "fetch";

/** Shipped models.dev bundle (§5.7); absent from the repo until `refresh-models-snapshot.ts` is run. */
export const COMMITTED_CATALOG_SNAPSHOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "models-dev.snapshot.json",
);

function committedSnapshotPath(env: CatalogEnv): string {
  const override = typeof env.HZ_MODELS_COMMITTED_SNAPSHOT === "string" ? env.HZ_MODELS_COMMITTED_SNAPSHOT.trim() : "";
  return override !== "" ? override : COMMITTED_CATALOG_SNAPSHOT;
}

function committedSnapshotDisabled(env: CatalogEnv): boolean {
  const off = env.HZ_NO_COMMITTED_SNAPSHOT ?? process.env.HZ_NO_COMMITTED_SNAPSHOT;
  return off === "1" || off === "true" || off === "yes";
}

/** User-cache file written by `hzcode models refresh` (docs/33 §5.8). */
export function catalogCachePath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "models-dev.cache.json");
}

/** Lightweight metadata sidecar for TTL / ETag / SHA-256 checks without rewriting multi-MB body. */
export function catalogCacheMetaPath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "models-dev.cache.meta.json");
}

export interface CatalogCacheMeta {
  /** Epoch milliseconds of the last successful check or refresh (OpenCode `updatedAt`). */
  updatedAt?: number;
  etag?: string;
  /** SHA-256 of the raw fetched body; a 200 with identical bytes is not a change. */
  digest?: string;
  fetchedAt: string;
  source: string;
  providerCount: number;
  modelCount: number;
}

export interface CatalogFetchResult {
  catalog: Catalog;
  notModified: boolean;
  etag?: string;
  digest?: string;
}

export interface LoadedCatalog extends Catalog {
  source: CatalogSource;
  /** SHA-256 hex digest of the loaded catalog bytes. */
  digest?: string;
}

/* --------------------------- tolerant decoding --------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function decodeModalities(raw: unknown): ModelModalities | undefined {
  const m = asRecord(raw);
  if (!m) return undefined;
  const out: ModelModalities = {};
  if (Array.isArray(m.input)) {
    const items = m.input.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out.input = items;
  }
  if (Array.isArray(m.output)) {
    const items = m.output.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out.output = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function decodeReasoningOptions(raw: Record<string, unknown>): ModelReasoningOptions | undefined {
  const opts: ModelReasoningOptions = {};
  if (typeof raw.toggle === "boolean") opts.toggle = raw.toggle;
  if (typeof raw.effort === "boolean") {
    opts.effort = raw.effort;
  } else if (Array.isArray(raw.effort)) {
    const levels = raw.effort.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim());
    if (levels.length > 0) opts.effort = levels;
  }
  if (typeof raw.budget === "boolean") {
    opts.budget = raw.budget;
  } else {
    const b = asRecord(raw.budget);
    if (b) {
      const budget: { min?: number; max?: number; default?: number } = {};
      const min = finite(b.min);
      const max = finite(b.max);
      const def = finite(b.default);
      if (min !== undefined) budget.min = min;
      if (max !== undefined) budget.max = max;
      if (def !== undefined) budget.default = def;
      if (Object.keys(budget).length > 0) opts.budget = budget;
    }
  }
  if (typeof raw.interleaved === "boolean") {
    opts.interleaved = raw.interleaved;
  } else {
    const inter = asRecord(raw.interleaved);
    const field = nonEmptyString(inter?.field);
    if (field !== undefined) opts.interleaved = { field };
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Decode context tiers from a models.dev `cost` (v1 `tiers` / `context_over_200k`)
 * or `cost.text` (v2 `overrides`) record. Tolerant: an entry without a numeric
 * size or without any finite per-token price is skipped.
 */
function decodeCostTiers(cost: Record<string, unknown>): ModelCostTier[] | undefined {
  const tiers: ModelCostTier[] = [];
  const parseTier = (raw: unknown, size: number | undefined): void => {
    const t = asRecord(raw);
    if (!t || size === undefined) return;
    const tier: ModelCostTier = { size };
    const input = finite(t.input);
    const output = finite(t.output);
    const read = finite(t.cache_read ?? t.cacheRead ?? t.cacheReadPerM);
    const write = finite(t.cache_write ?? t.cacheWrite ?? t.cacheWritePerM);
    if (input !== undefined) tier.input = input;
    if (output !== undefined) tier.output = output;
    if (read !== undefined) tier.cacheReadPerM = read;
    if (write !== undefined) tier.cacheWritePerM = write;
    if (input !== undefined || output !== undefined || read !== undefined || write !== undefined) {
      tiers.push(tier);
    }
  };
  if (Array.isArray(cost.tiers)) {
    for (const raw of cost.tiers) {
      const t = asRecord(raw);
      parseTier(raw, t ? finite(asRecord(t.tier)?.size ?? t.size) : undefined);
    }
  }
  if (Array.isArray(cost.overrides)) {
    for (const raw of cost.overrides) {
      const t = asRecord(raw);
      if (!t) continue;
      const cond = asRecord(t.condition);
      const size = finite(
        cond?.context_over ??
          cond?.prompt_tokens_over ??
          cond?.context ??
          cond?.size ??
          t.context_over ??
          t.size ??
          asRecord(t.tier)?.size,
      );
      parseTier(raw, size);
    }
  }
  parseTier(cost.context_over_200k, 200_000);
  return tiers.length > 0 ? tiers : undefined;
}

/**
 * Decode one model entry TOLERANTLY (mirrors opencode's per-model
 * `Schema.decodeUnknownResult`): returns the normalized model, or a readable
 * reason string. A reason is collected by the caller and never thrown — an
 * entry this build does not understand is skipped, not a failure of the whole
 * catalog. The only hard requirement is a numeric `limit.context`, because the
 * context window feeds NF-074's output fit.
 *
 * Handles both models.dev v2.0 nested fields (`capabilities.tools.supported`,
 * `capabilities.reasoning.{supported,toggle,effort,budget}`,
 * `capabilities.cache.explicit`, `cost.text.{input,output,overrides}`) and
 * already-normalized curated/snapshot flat fields. Enforces R50: missing or
 * non-per-token cost stays `undefined`, never `$0`.
 */
function decodeCacheWritePrice(rawCache: Record<string, unknown> | undefined): number | undefined {
  if (!rawCache) return undefined;
  const firstPrice = (val: unknown): number | undefined => {
    const direct = finite(val);
    if (direct !== undefined) return direct;
    const obj = asRecord(val);
    if (!obj) return undefined;
    for (const v of Object.values(obj)) {
      const n = finite(v);
      if (n !== undefined) return n;
    }
    return undefined;
  };
  return (
    firstPrice(rawCache.write) ??
    firstPrice(asRecord(rawCache.explicit)?.write)
  );
}

/**
 * Decode OpenCode / models.dev v2.0 nested `cost.text` shape:
 *   `{ input: { price, unit?, cache?: { read, write, explicit }, overrides? },
 *      output: { price, unit?, overrides? } }`
 * Enforces R50: non-per-token units or missing prices return `undefined` (never `$0`).
 */
function decodeNestedV2TextCost(textObj: Record<string, unknown>): ModelCost | undefined {
  const inObj = asRecord(textObj.input);
  const outObj = asRecord(textObj.output);
  if (!inObj && !outObj) return undefined;

  const isPerToken = (obj: Record<string, unknown> | undefined): boolean => {
    if (!obj) return true;
    const unit = nonEmptyString(obj.unit);
    return unit === undefined || unit === "token";
  };
  if (!isPerToken(inObj) || !isPerToken(outObj)) return undefined;

  const parsed: ModelCost = {};
  const inputPrice = finite(inObj?.price);
  const outputPrice = finite(outObj?.price);
  if (inputPrice !== undefined) parsed.input = inputPrice;
  if (outputPrice !== undefined) parsed.output = outputPrice;

  const inCache = asRecord(inObj?.cache);
  const cacheRead = finite(inCache?.read);
  const cacheWrite = decodeCacheWritePrice(inCache);
  if (cacheRead !== undefined) parsed.cacheReadPerM = cacheRead;
  if (cacheWrite !== undefined) parsed.cacheWritePerM = cacheWrite;

  const tiersBySize = new Map<number, ModelCostTier>();
  const contextSizeFromWhen = (rawWhen: unknown): number | undefined => {
    const when = asRecord(rawWhen);
    if (!when || Object.keys(when).length !== 1) return undefined;
    const ctx = asRecord(when.context);
    if (!ctx) return undefined;
    return finite(ctx.gt ?? ctx.gte);
  };
  if (Array.isArray(inObj?.overrides)) {
    for (const rawOv of inObj.overrides) {
      const ov = asRecord(rawOv);
      if (!ov) continue;
      const size = contextSizeFromWhen(ov.when);
      if (size === undefined) continue;
      const existing = tiersBySize.get(size) ?? { size };
      const ovIn = finite(ov.price);
      const ovCache = asRecord(ov.cache);
      const ovRead = finite(ovCache?.read);
      const ovWrite = decodeCacheWritePrice(ovCache);
      if (ovIn !== undefined) existing.input = ovIn;
      if (ovRead !== undefined) existing.cacheReadPerM = ovRead;
      if (ovWrite !== undefined) existing.cacheWritePerM = ovWrite;
      if (
        existing.input !== undefined ||
        existing.output !== undefined ||
        existing.cacheReadPerM !== undefined ||
        existing.cacheWritePerM !== undefined
      ) {
        tiersBySize.set(size, existing);
      }
    }
  }
  if (Array.isArray(outObj?.overrides)) {
    for (const rawOv of outObj.overrides) {
      const ov = asRecord(rawOv);
      if (!ov) continue;
      const size = contextSizeFromWhen(ov.when);
      if (size === undefined) continue;
      const existing = tiersBySize.get(size) ?? { size };
      const ovOut = finite(ov.price);
      if (ovOut !== undefined) existing.output = ovOut;
      if (
        existing.input !== undefined ||
        existing.output !== undefined ||
        existing.cacheReadPerM !== undefined ||
        existing.cacheWritePerM !== undefined
      ) {
        tiersBySize.set(size, existing);
      }
    }
  }
  if (tiersBySize.size > 0) parsed.tiers = [...tiersBySize.values()];
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function hasImageModality(modalities: ModelModalities | undefined): boolean {
  return Boolean(modalities?.input?.some((m) => m === "image" || m.startsWith("image/")));
}

function mostCommonValue<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestCount = 0;
  for (const v of values) {
    const next = (counts.get(v) ?? 0) + 1;
    counts.set(v, next);
    if (next > bestCount) {
      best = v;
      bestCount = next;
    }
  }
  return best;
}

export function decodeModel(provider: string, key: string, value: unknown): CatalogModel | string {
  const where = `${provider}/${key}`;
  const raw = asRecord(value);
  if (!raw) return `${where} is not an object`;
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : key;
  const limit = asRecord(raw.limit);
  const context = finite(limit?.context);
  if (context === undefined) return `${where} has no numeric limit.context`;
  const output = finite(limit?.output);
  const model: CatalogModel = { id, provider, limit: output !== undefined ? { context, output } : { context } };

  const modelType = nonEmptyString(raw.type);
  if (modelType !== undefined) model.type = modelType;
  const name = nonEmptyString(raw.name);
  if (name !== undefined) model.name = name;
  const family = nonEmptyString(raw.family);
  if (family !== undefined) model.family = family;
  const status = nonEmptyString(raw.status);
  if (status !== undefined) model.status = status;
  const releasedAt = nonEmptyString(raw.releasedAt ?? raw.released_at ?? raw.release_date);
  if (releasedAt !== undefined) model.releasedAt = releasedAt;
  const modalities = decodeModalities(raw.modalities);
  if (modalities !== undefined) model.modalities = modalities;

  const rawProviderObj = asRecord(raw.provider);
  const apiRoute = resolveApiRoute(raw.api);
  const protocol =
    mapProtocolIdentifier(raw.protocol ?? rawProviderObj?.protocol ?? rawProviderObj?.npm) ?? apiRoute?.protocol;
  if (protocol !== undefined) model.protocol = protocol;
  const baseUrl =
    nonEmptyString(raw.baseUrl ?? (typeof raw.api === "string" ? raw.api : undefined) ?? rawProviderObj?.baseUrl ?? rawProviderObj?.api) ??
    apiRoute?.baseUrl;
  if (baseUrl !== undefined) model.baseUrl = baseUrl;

  const rawHeaders = asRecord(raw.headers);
  const mergedHeaders: Record<string, string> = { ...(apiRoute?.headers ?? {}) };
  if (rawHeaders) {
    for (const [hk, hv] of Object.entries(rawHeaders)) {
      if (typeof hv === "string" && hv.trim() !== "") mergedHeaders[hk] = hv;
    }
  }
  if (Object.keys(mergedHeaders).length > 0) model.headers = mergedHeaders;

  const compatibility = asRecord(raw.compatibility);
  const mergedCompatibility: Record<string, unknown> = {
    ...(apiRoute?.compatibility ?? {}),
    ...(compatibility ?? {}),
  };
  if (Object.keys(mergedCompatibility).length > 0) {
    model.compatibility = mergedCompatibility;
  }

  const caps = asRecord(raw.capabilities);
  if (caps) {
    const capabilities: ModelCapabilities = {};
    if (typeof caps.tools === "boolean") {
      capabilities.tools = caps.tools;
    } else {
      const toolsObj = asRecord(caps.tools);
      if (toolsObj && typeof toolsObj.supported === "boolean") capabilities.tools = toolsObj.supported;
    }

    if (typeof caps.reasoning === "boolean") {
      capabilities.reasoning = caps.reasoning;
    } else {
      const reasoningObj = asRecord(caps.reasoning);
      if (reasoningObj) {
        if (typeof reasoningObj.supported === "boolean") capabilities.reasoning = reasoningObj.supported;
        const reasoningOptions = decodeReasoningOptions(reasoningObj);
        if (reasoningOptions !== undefined) capabilities.reasoningOptions = reasoningOptions;
      }
    }

    if (typeof caps.cacheControl === "boolean") {
      capabilities.cacheControl = caps.cacheControl;
    } else {
      const cacheObj = asRecord(caps.cache);
      if (cacheObj) {
        if (typeof cacheObj.explicit === "boolean") {
          capabilities.cacheControl = cacheObj.explicit;
        } else if (asRecord(cacheObj.explicit) !== undefined) {
          capabilities.cacheControl = true;
        }
      }
    }

    if (typeof caps.temperature === "boolean") {
      capabilities.temperature = caps.temperature;
    } else {
      const tempObj = asRecord(caps.temperature);
      if (tempObj && typeof tempObj.supported === "boolean") capabilities.temperature = tempObj.supported;
    }

    const soRaw = caps.structuredOutput ?? caps.structured_output;
    if (typeof soRaw === "boolean") {
      capabilities.structuredOutput = soRaw;
    } else {
      const soObj = asRecord(soRaw);
      if (soObj && typeof soObj.supported === "boolean") capabilities.structuredOutput = soObj.supported;
    }

    if (typeof caps.vision === "boolean") {
      capabilities.vision = caps.vision;
    } else {
      const visionObj = asRecord(caps.vision);
      if (visionObj && typeof visionObj.supported === "boolean") {
        capabilities.vision = visionObj.supported;
      } else if (hasImageModality(modalities)) {
        capabilities.vision = true;
      }
    }

    if (Object.keys(capabilities).length > 0) model.capabilities = capabilities;
  } else if (hasImageModality(modalities)) {
    model.capabilities = { vision: true };
  }

  // H-1: tolerant `accepts_settings` / `acceptsSettings` (string[] of param names).
  const acceptsRaw = raw.accepts_settings ?? raw.acceptsSettings;
  if (Array.isArray(acceptsRaw)) {
    const names: string[] = [];
    for (const entry of acceptsRaw) {
      if (typeof entry === "string" && entry.trim() !== "") names.push(entry.trim());
    }
    model.acceptsSettings = names;
  }

  const cost = asRecord(raw.cost);
  if (cost) {
    // v2.0 places per-token chat pricing under `cost.text` (either nested
    // `{ input: { price, cache, overrides }, output: { price, overrides } }` from
    // models.dev/OpenCode snapshot or flat `{ input, output, cache_read, cache_write }`).
    // R50: if `cost` carries no finite per-token numbers, `model.cost` stays `undefined`.
    const costText = asRecord(cost.text);
    const nestedCost = costText ? decodeNestedV2TextCost(costText) : undefined;
    if (nestedCost) {
      model.cost = nestedCost;
    } else {
      const costSource = costText ?? cost;
      const parsed: ModelCost = {};
      const input = finite(costSource.input);
      const out = finite(costSource.output);
      const read = finite(costSource.cache_read ?? costSource.cacheRead ?? costSource.cacheReadPerM);
      const write = finite(costSource.cache_write ?? costSource.cacheWrite ?? costSource.cacheWritePerM);
      if (input !== undefined) parsed.input = input;
      if (out !== undefined) parsed.output = out;
      if (read !== undefined) parsed.cacheReadPerM = read;
      if (write !== undefined) parsed.cacheWritePerM = write;
      const tiers = decodeCostTiers(costSource);
      if (tiers) parsed.tiers = tiers;
      if (Object.keys(parsed).length > 0) model.cost = parsed;
    }
  }
  return model;
}

/**
 * Decode one provider entry TOLERANTLY. Returns the normalized provider, or a
 * readable reason string; a provider with no usable models is rejected (there
 * is nothing to offer), but a SINGLE bad model inside an otherwise-good
 * provider is skipped and its reason pushed into `rejected`.
 */
function decodeProvider(key: string, value: unknown, rejected: string[]): CatalogProvider | string {
  const raw = asRecord(value);
  if (!raw) return `provider ${key} is not an object`;
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : key;
  const modelsRaw = asRecord(raw.models);
  if (!modelsRaw) return `provider ${id} has no models object`;
  const models: Record<string, CatalogModel> = {};
  for (const [modelKey, modelValue] of Object.entries(modelsRaw)) {
    const decoded = decodeModel(id, modelKey, modelValue);
    if (typeof decoded === "string") {
      rejected.push(decoded);
      continue;
    }
    models[decoded.id] = decoded;
  }
  if (Object.keys(models).length === 0) return `provider ${id} has no usable models`;
  const chatModels = Object.values(models).filter((m) => !m.type || m.type === "chat");
  const modelPool = chatModels.length > 0 ? chatModels : Object.values(models);
  const declaredDefault = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : "";
  const defaultModel = declaredDefault !== "" && models[declaredDefault] ? declaredDefault : modelPool[0]!.id;
  const provider: CatalogProvider = { id, defaultModel, models };
  const name = nonEmptyString(raw.name);
  if (name !== undefined) provider.name = name;
  if (Array.isArray(raw.env)) {
    const envVars = raw.env.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim());
    if (envVars.length > 0) provider.env = envVars;
  }
  // v2 snapshots carry per-model `api` routes rather than top-level `protocol`/`baseUrl`.
  // Derive provider defaults from the most common chat-model route (OpenCode parity).
  const derivedBaseUrl = mostCommonValue(
    modelPool.map((m) => m.baseUrl).filter((u): u is string => u !== undefined),
  );
  const baseUrl = nonEmptyString(raw.baseUrl ?? raw.api) ?? derivedBaseUrl;
  if (baseUrl !== undefined) provider.baseUrl = baseUrl;

  const derivedProtocol = mostCommonValue(
    modelPool.map((m) => m.protocol).filter((p): p is CatalogProviderProtocol => p !== undefined),
  );
  const protocol = mapProtocolIdentifier(raw.protocol ?? raw.npm) ?? derivedProtocol;
  if (protocol !== undefined) provider.protocol = protocol;
  return provider;
}

/**
 * Decode a whole catalog object into the reduced shape. The top-level `rejected`
 * carries every skipped provider or model; a top-level value that is not even an
 * object yields an empty catalog with one rejection line, never a throw. This is
 * the single tolerant-decode entry point shared by every `loadCatalog` branch.
 *
 * Automatically normalizes models.dev v1 (`/api.json`) payloads via
 * `normalizeV1ToV2()` so v1, v2, and already-normalized snapshots decode into
 * the same rich shape.
 */
export function decodeCatalog(value: unknown): Catalog {
  const rejected: string[] = [];
  const normalized = isV1Catalog(value) ? normalizeV1ToV2(value) : value;
  const container = asRecord(normalized);
  const providersRaw = container ? asRecord(container.providers) ?? container : undefined;
  if (!providersRaw) {
    return { providers: {}, rejected: ["catalog is not an object with a providers map"] };
  }
  const providers: Record<string, CatalogProvider> = {};
  for (const [key, entry] of Object.entries(providersRaw)) {
    // Skip the curated file's `$comment` and any other non-object metadata key
    // without recording it as a rejection: it is documentation, not a provider.
    if (key.startsWith("$")) continue;
    const decoded = decodeProvider(key, entry, rejected);
    if (typeof decoded === "string") {
      rejected.push(decoded);
      continue;
    }
    providers[decoded.id] = decoded;
  }
  return { providers, rejected };
}

/* ------------------------------ validation ------------------------------- */

/**
 * Enforce the MINIMUM_PROVIDERS floor on an EXTERNALLY-sourced snapshot (the env
 * override or a live fetch). opencode's rationale: "A floor, not equality:
 * guards against an error page or a truncated body that still parses as a small
 * object." Throws below the floor. It is DELIBERATELY NOT applied to the curated
 * boot-time floor, which is small by design (see the module header).
 */
export function validateCatalog(catalog: Catalog, opts: { minProviders?: number } = {}): Catalog {
  const minProviders = opts.minProviders ?? MINIMUM_PROVIDERS;
  const count = Object.keys(catalog.providers).length;
  if (count < minProviders) {
    throw new Error(`models catalog has ${count} providers, expected at least ${minProviders}`);
  }
  return catalog;
}

/* --------------------------------- seam ---------------------------------- */

/** The committed curated snapshot, decoded once (the boot-time offline floor). */
export function curatedCatalog(): Catalog {
  return decodeCatalog(curatedSnapshot as unknown);
}

/**
 * The live-fetch EXTENSION POINT (spec §5.4). This is where a real models.dev
 * fetch would land: GET `${source}${CATALOG_PATH}`, trim unused fields, decode
 * tolerantly, then `validateCatalog` against MINIMUM_PROVIDERS. It is DISABLED
 * under INTEGRATIONS_ONLY and is NEVER called from `loadCatalog` by default or
 * from tests — a byte-identical placeholder so the refresh seam is documented
 * without pulling the network into the build. Wiring it on would also add the
 * deferred ETag/digest refresh (opencode's `ModelsDev.refresh`).
 */
export type CatalogHttpFetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string; etag?: string }>;

async function defaultCatalogHttpFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; etag?: string }> {
  const res = await fetch(url, { headers });
  const etag = res.headers.get("etag") ?? undefined;
  const body = await res.text();
  return { status: res.status, body, etag };
}

/**
 * Conditional GET against models.dev (or mirror). `previousEtag` yields 304 →
 * `notModified: true` with an empty catalog object (caller keeps the cache).
 */
/** Called with the fetch URL before any HTTP I/O (docs/33 §5.8 — net.fetch guard). */
export type CatalogFetchGuard = (url: string) => void | Promise<void>;

export async function fetchLiveCatalog(
  source?: string,
  opts: {
    etag?: string;
    fetcher?: CatalogHttpFetch;
    minProviders?: number;
    /** Guard hook: throw or reject to block the fetch (egress / policy). */
    assertNetFetch?: CatalogFetchGuard;
    /** Injectable environment for `HZ_MODELS_URL` and `HZ_DISABLE_MODELS_FETCH`. */
    env?: CatalogEnv;
  } = {},
): Promise<CatalogFetchResult> {
  const env = opts.env ?? process.env;
  if (isModelsFetchDisabled(env)) {
    throw new Error("models catalog fetch disabled by HZ_DISABLE_MODELS_FETCH");
  }
  const fetcher = opts.fetcher ?? defaultCatalogHttpFetch;
  const effectiveSource = resolveCatalogSource(source, env).replace(/\/+$/, "");
  const isDirectJsonUrl = effectiveSource.endsWith(".json") || effectiveSource.includes("/api.json");
  const url = isDirectJsonUrl ? effectiveSource : effectiveSource + CATALOG_PATH;
  if (opts.assertNetFetch) await opts.assertNetFetch(url);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  let res = await fetcher(url, headers);
  if (res.status === 404 && !isDirectJsonUrl) {
    const v1Url = effectiveSource + CATALOG_V1_PATH;
    if (opts.assertNetFetch) await opts.assertNetFetch(v1Url);
    res = await fetcher(v1Url, headers);
  }
  if (res.status === 304) return { catalog: { providers: {}, rejected: [] }, notModified: true, etag: opts.etag };
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`models catalog fetch failed: HTTP ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("models catalog fetch returned non-JSON");
  }
  const catalog = validateCatalog(decodeCatalog(parsed), { minProviders: opts.minProviders });
  return {
    catalog,
    notModified: false,
    etag: res.etag ?? opts.etag,
    digest: sha256Hex(res.body),
  };
}

export function countCatalogModels(catalog: Catalog): number {
  let n = 0;
  for (const p of Object.values(catalog.providers)) n += Object.keys(p.models).length;
  return n;
}

/** One-line diff summary for `hzcode models refresh` (docs/33 §5.8). */
export function summarizeCatalogDiff(before: Catalog, after: Catalog): string {
  const bp = new Set(Object.keys(before.providers));
  const ap = new Set(Object.keys(after.providers));
  const added = [...ap].filter((id) => !bp.has(id));
  const removed = [...bp].filter((id) => !ap.has(id));
  const parts = [
    `providers ${bp.size}→${ap.size}`,
    `models ${countCatalogModels(before)}→${countCatalogModels(after)}`,
  ];
  if (added.length > 0) {
    const shown = added.slice(0, 5).join(", ");
    parts.push(`+providers: ${shown}${added.length > 5 ? ` (+${added.length - 5} more)` : ""}`);
  }
  if (removed.length > 0) {
    const shown = removed.slice(0, 5).join(", ");
    parts.push(`-providers: ${shown}${removed.length > 5 ? ` (+${removed.length - 5} more)` : ""}`);
  }
  return parts.join("; ");
}

/**
 * Pure staleness check for notices/refresh eligibility. A stale cache is still
 * USED — this never triggers a network call on boot. Default TTL is opencode's
 * five minutes.
 */
export function isCatalogCacheStale(
  meta: Pick<CatalogCacheMeta, "fetchedAt"> | undefined,
  now: number = Date.now(),
  ttlMs: number = 5 * 60_000,
): boolean {
  if (meta === undefined) return true;
  const fetched = Date.parse(meta.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  return now - fetched >= ttlMs;
}

/** Bumped on every successful user-cache write (poll or `models refresh`). */
let catalogCacheRevision = 0;

export function getCatalogCacheRevision(): number {
  return catalogCacheRevision;
}

/** Write the validated cache atomically (mode 0600). */

/** H-7: contracted form of `hzcode models refresh` outcome (ruling 598). */
export function modelsRefreshPublication(input: {
  providerCount: number;
  unchanged: boolean;
}): string[] {
  const anchor = "none — this models-refresh invocation";
  const population = "providers in the fetched/cached models catalog for this refresh";
  const excludes = "none — unchanged is a boolean outcome of 304/same-digest short-circuit";
  return [
    metricContract({
      metric: "models refresh providers",
      anchor,
      population,
      excludes,
      value: input.providerCount,
    }),
    metricContract({
      metric: "models refresh unchanged",
      anchor,
      population,
      excludes,
      value: input.unchanged ? 1 : 0,
    }),
  ];
}

/** H-7: contracted form of `hzcode --list-models` count (ruling 602). */
export function modelsListPublication(input: { listed: number; provider: string }): string[] {
  const anchor = "none — this --list-models invocation";
  const population = `model ids listed for provider ${input.provider} after optional substring filter`;
  const excludes = "none — every id printed (or the empty-list notice) is counted";
  return [
    metricContract({
      metric: "models list count",
      anchor,
      population,
      excludes,
      value: input.listed,
    }),
  ];
}

/** Stat-keyed in-memory cache so repeated loadCatalog() calls on the 8 MB snapshot are instant. */
const snapshotFileCache = new Map<string, { mtimeMs: number; size: number; minProviders: number; result: { catalog: Catalog; digest: string } }>();

export function invalidateCatalogMemoryCache(): void {
  snapshotFileCache.clear();
}

/** Write only the lightweight cache metadata sidecar (used on 304 / unchanged SHA-256 digest). */
export function writeCatalogCacheMeta(meta: CatalogCacheMeta, home: string = homedir()): string {
  const file = catalogCacheMetaPath(home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const updatedAt =
    typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt)
      ? meta.updatedAt
      : Date.parse(meta.fetchedAt) || Date.now();
  const payload: CatalogCacheMeta = { ...meta, updatedAt };
  const tmp = file + ".tmp";
  writeFileSync(tmp, canonicalJson(payload) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return file;
}

/** Read lightweight cache metadata (`models-dev.cache.meta.json`), falling back to the full cache file. */
export function readCatalogCacheMeta(home: string = homedir()): CatalogCacheMeta | undefined {
  const metaFile = catalogCacheMetaPath(home);
  try {
    const raw = readFileSync(metaFile, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (parsed && typeof parsed.fetchedAt === "string") {
      const updatedAt =
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : Date.parse(parsed.fetchedAt);
      return {
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
        fetchedAt: parsed.fetchedAt,
        source: typeof parsed.source === "string" ? parsed.source : DEFAULT_CATALOG_SOURCE,
        etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
        digest: typeof parsed.digest === "string" ? parsed.digest : undefined,
        providerCount: typeof parsed.providerCount === "number" ? parsed.providerCount : 0,
        modelCount: typeof parsed.modelCount === "number" ? parsed.modelCount : 0,
      };
    }
  } catch {
    /* fall through to full cache */
  }
  return readCatalogCache(home)?.meta;
}

export function writeCatalogCache(catalog: Catalog, meta: Omit<CatalogCacheMeta, "providerCount" | "modelCount">, home: string = homedir()): string {
  const file = catalogCachePath(home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const updatedAt =
    typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt)
      ? meta.updatedAt
      : Date.parse(meta.fetchedAt) || Date.now();
  const fullMeta: CatalogCacheMeta = {
    ...meta,
    updatedAt,
    providerCount: Object.keys(catalog.providers).length,
    modelCount: countCatalogModels(catalog),
  };
  const payload = {
    meta: fullMeta,
    catalog,
  };
  const tmp = file + ".tmp";
  writeFileSync(tmp, canonicalJson(payload) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  try {
    writeCatalogCacheMeta(fullMeta, home);
  } catch {
    /* best effort */
  }
  catalogCacheRevision += 1;
  return file;
}

export function readCatalogCache(home: string = homedir()): { catalog: Catalog; meta: CatalogCacheMeta } | undefined {
  const file = catalogCachePath(home);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const top = asRecord(parsed);
  if (!top) return undefined;
  const catalog = decodeCatalog(top.catalog);
  const metaRaw = asRecord(top.meta);
  if (!metaRaw || typeof metaRaw.fetchedAt !== "string") return undefined;
  const parsedUpdatedAt =
    typeof metaRaw.updatedAt === "number" && Number.isFinite(metaRaw.updatedAt)
      ? metaRaw.updatedAt
      : Date.parse(metaRaw.fetchedAt);
  const meta: CatalogCacheMeta = {
    updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : undefined,
    fetchedAt: metaRaw.fetchedAt,
    source: typeof metaRaw.source === "string" ? metaRaw.source : DEFAULT_CATALOG_SOURCE,
    etag: typeof metaRaw.etag === "string" ? metaRaw.etag : undefined,
    digest: typeof metaRaw.digest === "string" ? metaRaw.digest : undefined,
    providerCount: typeof metaRaw.providerCount === "number" ? metaRaw.providerCount : Object.keys(catalog.providers).length,
    modelCount: typeof metaRaw.modelCount === "number" ? metaRaw.modelCount : countCatalogModels(catalog),
  };
  try {
    validateCatalog(catalog, { minProviders: MINIMUM_PROVIDERS });
  } catch {
    return undefined;
  }
  return { catalog, meta };
}

/**
 * Load a catalog from a snapshot FILE (the `HZ_MODELS_SNAPSHOT` / `HZ_MODELS_PATH`
 * override path). Anything unreadable, non-JSON or below the floor returns
 * `undefined` so the caller falls back cleanly — an external snapshot is a best
 * effort, never a reason to fail boot. Exported so tests can exercise the
 * override path with a temp file.
 */
function loadSnapshotFileWithDigest(
  file: string,
  minProviders: number = MINIMUM_PROVIDERS,
): { catalog: Catalog; digest: string } | undefined {
  let stat: { mtimeMs: number; size: number } | undefined;
  try {
    const s = statSync(file);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
    const cached = snapshotFileCache.get(file);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.minProviders === minProviders
    ) {
      return cached.result;
    }
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const catalog = decodeCatalog(parsed);
  try {
    const result = { catalog: validateCatalog(catalog, { minProviders }), digest: sha256Hex(raw) };
    if (stat) {
      snapshotFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, minProviders, result });
    }
    return result;
  } catch {
    return undefined;
  }
}

export function loadSnapshotFile(file: string, minProviders: number = MINIMUM_PROVIDERS): Catalog | undefined {
  return loadSnapshotFileWithDigest(file, minProviders)?.catalog;
}

function loadCommittedCatalogWithDigest(env: CatalogEnv): { catalog: Catalog; digest: string } | undefined {
  if (committedSnapshotDisabled(env)) return undefined;
  const file = committedSnapshotPath(env);
  if (!existsSync(file)) return undefined;
  return loadSnapshotFileWithDigest(file);
}

export type CatalogEnv = Record<string, string | undefined>;

let curatedDigestCache: string | undefined;
function curatedCatalogDigest(): string {
  if (curatedDigestCache === undefined) {
    curatedDigestCache = sha256Hex(canonicalJson(curatedSnapshot));
  }
  return curatedDigestCache;
}

function isFreeCatalogModel(model: CatalogModel): boolean {
  if (model.id.toLowerCase().endsWith(":free")) return true;
  if (model.cost && model.cost.input === 0 && model.cost.output === 0) return true;
  return false;
}

function applyFreeModelsFilter(catalog: LoadedCatalog, env: CatalogEnv): LoadedCatalog {
  if (!isFreeModelsDisabled(env)) return catalog;
  const providers: Record<string, CatalogProvider> = {};
  for (const [pid, prov] of Object.entries(catalog.providers)) {
    const kept: Record<string, CatalogModel> = {};
    for (const [mid, model] of Object.entries(prov.models)) {
      if (!isFreeCatalogModel(model)) kept[mid] = model;
    }
    const ids = Object.keys(kept);
    if (ids.length === 0) continue;
    const defaultModel = kept[prov.defaultModel] ? prov.defaultModel : ids[0]!;
    providers[pid] = { ...prov, defaultModel, models: kept };
  }
  return { ...catalog, providers };
}

/**
 * Resolve the effective catalog (pure; the environment is injectable). Precedence:
 *   (1) `HZ_MODELS_PATH` — local catalog file override bypassing cache (OpenCode parity);
 *   (2) `HZ_MODELS_SNAPSHOT` — a validated external snapshot file (>= MINIMUM_PROVIDERS);
 *   (3) the user cache from `hzcode models refresh` or background poll;
 *   (4) the committed `models-dev.snapshot.json` when present (OpenCode trimmed v2 snapshot);
 *   (5) the curated offline snapshot (the boot floor).
 * The live-fetch path stays an explicit extension point and is not consulted here.
 */
export function loadCatalog(env: CatalogEnv = process.env, home: string = homedir()): LoadedCatalog {
  const localPath = resolveModelsPath(env);
  if (localPath !== undefined) {
    const fromLocal = loadSnapshotFileWithDigest(localPath, 1);
    if (fromLocal) {
      return applyFreeModelsFilter({ ...fromLocal.catalog, source: "override", digest: fromLocal.digest }, env);
    }
  }
  const override = typeof env.HZ_MODELS_SNAPSHOT === "string" ? env.HZ_MODELS_SNAPSHOT.trim() : "";
  if (override !== "") {
    const fromFile = loadSnapshotFileWithDigest(override);
    if (fromFile) {
      return applyFreeModelsFilter({ ...fromFile.catalog, source: "override", digest: fromFile.digest }, env);
    }
  }
  const cached = readCatalogCache(home);
  if (cached) {
    let digest = cached.meta.digest;
    if (digest === undefined) {
      try {
        digest = sha256Hex(readFileSync(catalogCachePath(home), "utf8"));
      } catch {
        /* best effort */
      }
    }
    return applyFreeModelsFilter({ ...cached.catalog, source: "cache", digest }, env);
  }
  const committed = loadCommittedCatalogWithDigest(env);
  if (committed) {
    return applyFreeModelsFilter({ ...committed.catalog, source: "snapshot", digest: committed.digest }, env);
  }
  return applyFreeModelsFilter({ ...curatedCatalog(), source: "curated", digest: curatedCatalogDigest() }, env);
}

/* ------------------------------- lookups --------------------------------- */

/** The catalog's default model id for a provider, or undefined when it lacks it. */
export function catalogDefaultModel(catalog: Catalog, provider: string): string | undefined {
  return catalog.providers[provider]?.defaultModel;
}

/** One catalog model record for `(provider, model)`, or undefined when absent. */
export function catalogModel(catalog: Catalog, provider: string, model: string): CatalogModel | undefined {
  return catalog.providers[provider]?.models[model];
}

/**
 * Resolve per-token cost rates for `(provider, model)` from the catalog,
 * applying the largest matching context-size tier when `promptTokens` is
 * supplied. Enforces R50: returns `undefined` when the model or its per-token
 * cost is absent (never fabricates `$0`).
 */
export function catalogCost(
  catalog: Catalog | undefined,
  provider: string,
  model: string,
  promptTokens?: number,
): ResolvedModelCost | undefined {
  const cost = catalog?.providers[provider]?.models[model]?.cost;
  if (!cost) return undefined;

  let matchedTier: ModelCostTier | undefined;
  if (promptTokens !== undefined && Number.isFinite(promptTokens) && Array.isArray(cost.tiers)) {
    for (const candidate of cost.tiers) {
      if (promptTokens >= candidate.size && (matchedTier === undefined || candidate.size > matchedTier.size)) {
        matchedTier = candidate;
      }
    }
  }

  const input = matchedTier?.input ?? cost.input;
  const output = matchedTier?.output ?? cost.output;
  const cacheReadPerM = matchedTier?.cacheReadPerM ?? cost.cacheReadPerM;
  const cacheWritePerM = matchedTier?.cacheWritePerM ?? cost.cacheWritePerM;

  const out: ResolvedModelCost = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheReadPerM !== undefined) out.cacheReadPerM = cacheReadPerM;
  if (cacheWritePerM !== undefined) out.cacheWritePerM = cacheWritePerM;
  if (matchedTier !== undefined) out.tierSize = matchedTier.size;

  if (
    out.input === undefined &&
    out.output === undefined &&
    out.cacheReadPerM === undefined &&
    out.cacheWritePerM === undefined
  ) {
    return undefined;
  }
  return out;
}

/**
 * The context window (tokens) for `(provider, model)` from the catalog, or
 * `undefined` when the catalog lacks it. A PURE resolver (spec §5.4 step 4):
 * callers prefer this over the hardcoded `windowForModel` table and fall back
 * to it when this returns `undefined`.
 *
 * HOOKUP POINT (documented, intentionally NOT wired here): NF-074's output fit
 * reads the window at `app/src/core/loop.ts:~1106`
 * (`const contextWindow = windowForModel(deps.model)`), which is INTEGRATOR-
 * FENCED (one-writer). When the integrator wires the catalog, they resolve the
 * catalog once at boot and compute the window as
 * `catalogWindow(provider, model, catalog) ?? windowForModel(model)` — a
 * non-breaking seam that keeps the existing table as the fallback. This
 * resolver is ready for that call; loop.ts is left untouched.
 */
export function catalogWindow(provider: string, model: string, catalog: Catalog = loadCatalog()): number | undefined {
  return catalog.providers[provider]?.models[model]?.limit.context;
}

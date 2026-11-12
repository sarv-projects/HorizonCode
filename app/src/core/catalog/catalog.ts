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
 *  - `loadCatalog()` with a three-way precedence seam:
 *      (1) an explicit snapshot file via `HZ_MODELS_SNAPSHOT` (env), if set and
 *          valid — an EXTERNALLY-sourced snapshot, so it is floor-validated;
 *      (2) the committed curated snapshot (`models-dev.curated.json`), the
 *          boot-time floor — small and OFFLINE, so NOT floor-validated;
 *      (3) a documented-but-NOT-default live-fetch extension point
 *          (`fetchLiveCatalog`) — disabled under INTEGRATIONS_ONLY and never
 *          called from tests. It is where a real models.dev fetch would land.
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

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../canon";
import { userConfigDir } from "../paths";
import curatedSnapshot from "./models-dev.curated.json";

/** opencode's build-time floor (packages/core/script/models-snapshot.ts). */
export const MINIMUM_PROVIDERS = 100;

/**
 * The v2 experimental models.dev API, restricted to chat models — the path the
 * live-fetch extension point would GET from `https://models.opencode.ai` (the
 * opencode mirror) or models.dev directly. Named here so the refresh hookup is
 * documented even though it is not wired.
 */
export const CATALOG_PATH = "/experimental/v2.0/api.json?type=chat";
export const DEFAULT_CATALOG_SOURCE = "https://models.opencode.ai";

/** Per-token cost in USD per million tokens; a reduced slice of models.dev. */
export interface ModelCost {
  input?: number;
  output?: number;
}

/** The capabilities HorizonCode reads — DATA, never inferred from the id. */
export interface ModelCapabilities {
  tools?: boolean;
  reasoning?: boolean;
}

/** One catalog model, the reduced normalized shape (opencode `Model.Info`). */
export interface CatalogModel {
  id: string;
  provider: string;
  limit: { context: number; output?: number };
  capabilities?: ModelCapabilities;
  cost?: ModelCost;
}

/** One catalog provider: its default model id and its models by id. */
export interface CatalogProvider {
  id: string;
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

function loadCommittedCatalog(env: CatalogEnv): Catalog | undefined {
  if (committedSnapshotDisabled(env)) return undefined;
  const file = committedSnapshotPath(env);
  if (!existsSync(file)) return undefined;
  return loadSnapshotFile(file);
}

/** User-cache file written by `hzcode models refresh` (docs/33 §5.8). */
export function catalogCachePath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "models-dev.cache.json");
}

export interface CatalogCacheMeta {
  etag?: string;
  fetchedAt: string;
  source: string;
  providerCount: number;
  modelCount: number;
}

export interface CatalogFetchResult {
  catalog: Catalog;
  notModified: boolean;
  etag?: string;
}

export interface LoadedCatalog extends Catalog {
  source: CatalogSource;
}

/* --------------------------- tolerant decoding --------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Decode one model entry TOLERANTLY (mirrors opencode's per-model
 * `Schema.decodeUnknownResult`): returns the normalized model, or a readable
 * reason string. A reason is collected by the caller and never thrown — an
 * entry this build does not understand is skipped, not a failure of the whole
 * catalog. The only hard requirement is a numeric `limit.context`, because the
 * context window feeds NF-074's output fit.
 */
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

  const caps = asRecord(raw.capabilities);
  if (caps) {
    const capabilities: ModelCapabilities = {};
    if (typeof caps.tools === "boolean") capabilities.tools = caps.tools;
    if (typeof caps.reasoning === "boolean") capabilities.reasoning = caps.reasoning;
    if (Object.keys(capabilities).length > 0) model.capabilities = capabilities;
  }

  const cost = asRecord(raw.cost);
  if (cost) {
    const parsed: ModelCost = {};
    const input = finite(cost.input);
    const out = finite(cost.output);
    if (input !== undefined) parsed.input = input;
    if (out !== undefined) parsed.output = out;
    if (Object.keys(parsed).length > 0) model.cost = parsed;
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
  const declaredDefault = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : "";
  const defaultModel = declaredDefault !== "" && models[declaredDefault] ? declaredDefault : Object.keys(models)[0]!;
  return { id, defaultModel, models };
}

/**
 * Decode a whole catalog object into the reduced shape. The top-level `rejected`
 * carries every skipped provider or model; a top-level value that is not even an
 * object yields an empty catalog with one rejection line, never a throw. This is
 * the single tolerant-decode entry point shared by every `loadCatalog` branch.
 */
export function decodeCatalog(value: unknown): Catalog {
  const rejected: string[] = [];
  const container = asRecord(value);
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
  source: string = DEFAULT_CATALOG_SOURCE,
  opts: {
    etag?: string;
    fetcher?: CatalogHttpFetch;
    minProviders?: number;
    /** Guard hook: throw or reject to block the fetch (egress / policy). */
    assertNetFetch?: CatalogFetchGuard;
  } = {},
): Promise<CatalogFetchResult> {
  const fetcher = opts.fetcher ?? defaultCatalogHttpFetch;
  const url = source.replace(/\/+$/, "") + CATALOG_PATH;
  if (opts.assertNetFetch) await opts.assertNetFetch(url);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  const res = await fetcher(url, headers);
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
  return { catalog, notModified: false, etag: res.etag ?? opts.etag };
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

/** Write the validated cache atomically (mode 0600). */
export function writeCatalogCache(catalog: Catalog, meta: Omit<CatalogCacheMeta, "providerCount" | "modelCount">, home: string = homedir()): string {
  const file = catalogCachePath(home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    meta: {
      ...meta,
      providerCount: Object.keys(catalog.providers).length,
      modelCount: countCatalogModels(catalog),
    },
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
  const meta: CatalogCacheMeta = {
    fetchedAt: metaRaw.fetchedAt,
    source: typeof metaRaw.source === "string" ? metaRaw.source : DEFAULT_CATALOG_SOURCE,
    etag: typeof metaRaw.etag === "string" ? metaRaw.etag : undefined,
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
 * Load a catalog from a snapshot FILE (the `HZ_MODELS_SNAPSHOT` override path).
 * Anything unreadable, non-JSON or below the floor returns `undefined` so the
 * caller falls back to the curated snapshot — an external snapshot is a best
 * effort, never a reason to fail boot. The floor IS applied here (external
 * source). Exported so tests can exercise the override path with a temp file.
 */
export function loadSnapshotFile(file: string, minProviders: number = MINIMUM_PROVIDERS): Catalog | undefined {
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
    return validateCatalog(catalog, { minProviders });
  } catch {
    return undefined;
  }
}

export type CatalogEnv = Record<string, string | undefined>;

/**
 * Resolve the effective catalog (pure; the environment is injectable). Precedence:
 *   (1) `HZ_MODELS_SNAPSHOT` — a validated external snapshot file, if present;
 *   (2) the committed `models-dev.snapshot.json` when present (human refresh script);
 *   (3) the user cache from `hzcode models refresh`;
 *   (4) the committed curated snapshot (the offline floor).
 * The live-fetch path stays an explicit extension point and is not consulted here.
 */
export function loadCatalog(env: CatalogEnv = process.env, home: string = homedir()): LoadedCatalog {
  const override = typeof env.HZ_MODELS_SNAPSHOT === "string" ? env.HZ_MODELS_SNAPSHOT.trim() : "";
  if (override !== "") {
    const fromFile = loadSnapshotFile(override);
    if (fromFile) return { ...fromFile, source: "override" };
  }
  const committed = loadCommittedCatalog(env);
  if (committed) return { ...committed, source: "snapshot" };
  const cached = readCatalogCache(home);
  if (cached) return { ...cached.catalog, source: "cache" };
  return { ...curatedCatalog(), source: "curated" };
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

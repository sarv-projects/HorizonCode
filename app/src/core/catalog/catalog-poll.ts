/**
 * Non-blocking ETag + SHA-256 models.dev refresh, boot refresh trigger, and
 * optional periodic background poll (OpenCode `ModelsDev.refresh` parity).
 *
 * - `triggerBootCatalogRefresh()`: fire-and-forget, never blocks startup.
 * - `refreshModelsCatalog({ force })`: 5-minute TTL short-circuit, conditional
 *   `If-None-Match` ETag (`304` -> metadata `updatedAt` only), SHA-256 digest
 *   equality (`200` with same bytes -> metadata only), atomic write on change.
 * - `startModelsCatalogPoll()`: optional background interval polling with
 *   `.unref()` so it never keeps the CLI process alive.
 */

import { homedir } from "node:os";
import type { GuardDecision } from "../../contracts";
import { guardEffectivelyAllows } from "../guard-g1-wire";
import {
  CATALOG_PATH,
  CATALOG_V1_PATH,
  catalogCachePath,
  countCatalogModels,
  type CatalogEnv,
  type CatalogFetchGuard,
  fetchLiveCatalog,
  getCatalogCacheRevision,
  isModelsFetchDisabled,
  loadCatalog,
  readCatalogCache,
  readCatalogCacheMeta,
  resolveCatalogSource,
  resolveModelsPath,
  summarizeCatalogDiff,
  writeCatalogCache,
  writeCatalogCacheMeta,
} from "./catalog";

/** Default 5-minute TTL matching OpenCode's `Duration.minutes(5)`. */
export const DEFAULT_CATALOG_REFRESH_TTL_MS = 5 * 60_000;

/** Default 5-minute background poll interval for long-running TUI/server sessions. */
export const DEFAULT_CATALOG_POLL_INTERVAL_MS = 5 * 60_000;

export function modelsCatalogFetchUrl(source?: string, env: CatalogEnv = process.env): string {
  const resolved = resolveCatalogSource(source, env).replace(/\/+$/, "");
  if (resolved.endsWith(".json") || resolved.includes("/api.json")) return resolved;
  return resolved + CATALOG_PATH;
}

function modelsCatalogV1FallbackUrl(source?: string, env: CatalogEnv = process.env): string {
  const resolved = resolveCatalogSource(source, env).replace(/\/+$/, "");
  if (resolved.endsWith(".json") || resolved.includes("/api.json")) return resolved;
  return resolved + CATALOG_V1_PATH;
}

/** Fail-closed guard hook for runtime poll (`net.fetch`; background cannot `ask`). */
export function makeModelsCatalogPollNetGuard(
  checkNetFetch: (url: string) => Promise<GuardDecision>,
  env: CatalogEnv = process.env,
): CatalogFetchGuard {
  const expected = modelsCatalogFetchUrl(undefined, env);
  const expectedV1 = modelsCatalogV1FallbackUrl(undefined, env);
  return async (url: string) => {
    if (url !== expected && url !== expectedV1) throw new Error(`unexpected catalog URL: ${url}`);
    const guard = await checkNetFetch(url);
    if (guard.decision === "deny") {
      throw new Error(`net.fetch denied — ${guard.reason ?? "egress policy"}`);
    }
    if (guard.decision === "ask" && !guardEffectivelyAllows(guard)) {
      throw new Error("net.fetch requires approval (background poll cannot prompt)");
    }
  };
}

/** Fail-closed Guard for catalog cache `fs.write` (ruling 576; background cannot `ask`). */
export function makeModelsCatalogPollCacheWriteGuard(
  checkFsWrite: (target: string) => Promise<GuardDecision>,
  home: string = homedir(),
): (target: string) => Promise<void> {
  const expected = catalogCachePath(home);
  return async (target: string) => {
    if (target !== expected) throw new Error(`unexpected catalog cache path: ${target}`);
    const guard = await checkFsWrite(target);
    if (guard.decision === "deny") {
      throw new Error(`fs.write denied — ${guard.reason ?? "cache write policy"}`);
    }
    if (guard.decision === "ask" && !guardEffectivelyAllows(guard)) {
      throw new Error("fs.write requires approval (background poll cannot prompt)");
    }
  };
}

export function parseModelsPollIntervalMs(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): number | undefined {
  if (isModelsFetchDisabled(env)) return undefined;
  if (resolveModelsPath(env) !== undefined) return undefined;
  const raw = typeof env.HZ_MODELS_POLL_MS === "string" ? env.HZ_MODELS_POLL_MS.trim() : "";
  if (raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60_000) return undefined;
  return n;
}

export type ModelsPollStop = () => void;

export type ModelsCatalogPollOpts = {
  home?: string;
  env?: CatalogEnv;
  onNotice?: (message: string) => void;
  /** Fired after a successful cache write (revision + diff summary). */
  onCacheUpdated?: (info: { revision: number; providerCount: number; diff?: string }) => void;
  fetchLive?: typeof fetchLiveCatalog;
  /** Consulted before HTTP (runtime wires kernel `net.fetch`). */
  assertNetFetch?: CatalogFetchGuard;
  /** Consulted before cache write (ruling 576). */
  assertCacheWrite?: (target: string) => Promise<void>;
};

export interface RefreshModelsCatalogOpts extends ModelsCatalogPollOpts {
  /** Bypass 5-minute TTL and If-None-Match ETag (manual CLI / `/models refresh`). */
  force?: boolean;
  /** Override 5-minute TTL (ms). Defaults to `DEFAULT_CATALOG_REFRESH_TTL_MS`. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Optional custom source URL override. */
  source?: string;
}

export type RefreshModelsCatalogStatus =
  | "updated"
  | "not-modified"
  | "unchanged-digest"
  | "skipped-ttl"
  | "skipped-disabled"
  | "skipped-local-path"
  | "error";

export interface RefreshModelsCatalogResult {
  status: RefreshModelsCatalogStatus;
  providerCount?: number;
  modelCount?: number;
  etag?: string;
  digest?: string;
  diff?: string;
  message: string;
}

/**
 * Refresh the models.dev catalog using OpenCode's ETag + SHA-256 + 5-minute TTL
 * algorithm. Used by `triggerBootCatalogRefresh()`, `runModelsCatalogPollOnce()`,
 * `/models refresh`, and `hzcode models refresh`.
 */
export async function refreshModelsCatalog(
  opts: RefreshModelsCatalogOpts = {},
): Promise<RefreshModelsCatalogResult> {
  const env = opts.env ?? process.env;
  if (isModelsFetchDisabled(env)) {
    const message = "models catalog poll: disabled by HZ_DISABLE_MODELS_FETCH";
    opts.onNotice?.(message);
    return { status: "skipped-disabled", message };
  }
  if (resolveModelsPath(env) !== undefined) {
    const message = "models catalog refresh: skipped (HZ_MODELS_PATH local override active)";
    opts.onNotice?.(message);
    return { status: "skipped-local-path", message };
  }

  const home = opts.home ?? homedir();
  const force = opts.force === true;
  const ttlMs = opts.ttlMs ?? DEFAULT_CATALOG_REFRESH_TTL_MS;
  const nowMs = (opts.now ?? Date.now)();

  try {
    const storedMeta = readCatalogCacheMeta(home);
    if (
      !force &&
      storedMeta?.updatedAt !== undefined &&
      nowMs - storedMeta.updatedAt < ttlMs
    ) {
      const message = "models catalog refresh: skipped (within 5m TTL)";
      return {
        status: "skipped-ttl",
        providerCount: storedMeta.providerCount,
        modelCount: storedMeta.modelCount,
        etag: storedMeta.etag,
        digest: storedMeta.digest,
        message,
      };
    }

    const etag = force ? undefined : storedMeta?.etag;
    const res =
      opts.fetchLive !== undefined && opts.fetchLive !== fetchLiveCatalog
        ? await (async () => {
            if (opts.assertNetFetch) await opts.assertNetFetch(modelsCatalogFetchUrl(opts.source, env));
            return opts.fetchLive!(opts.source, { etag, env });
          })()
        : await fetchLiveCatalog(opts.source, { etag, assertNetFetch: opts.assertNetFetch, env });

    const nowIso = new Date(nowMs).toISOString();
    if (res.notModified) {
      if (storedMeta) {
        await opts.assertCacheWrite?.(catalogCachePath(home));
        try {
          writeCatalogCacheMeta(
            { ...storedMeta, updatedAt: nowMs, fetchedAt: nowIso, etag: res.etag ?? storedMeta.etag },
            home,
          );
        } catch {
          /* best effort */
        }
      }
      const message = "models catalog poll: not modified";
      opts.onNotice?.(message);
      return {
        status: "not-modified",
        providerCount: storedMeta?.providerCount,
        modelCount: storedMeta?.modelCount,
        etag: res.etag ?? storedMeta?.etag,
        digest: storedMeta?.digest,
        message,
      };
    }

    if (!force && res.digest !== undefined && storedMeta?.digest !== undefined && res.digest === storedMeta.digest) {
      // Same bytes under a new ETag: update metadata only, no cache rewrite or revision bump.
      await opts.assertCacheWrite?.(catalogCachePath(home));
      try {
        writeCatalogCacheMeta(
          {
            ...storedMeta,
            updatedAt: nowMs,
            fetchedAt: nowIso,
            etag: res.etag ?? storedMeta.etag,
            digest: res.digest,
          },
          home,
        );
      } catch {
        /* best effort */
      }
      const message = "models catalog poll: body unchanged (same digest)";
      opts.onNotice?.(message);
      return {
        status: "unchanged-digest",
        providerCount: storedMeta.providerCount,
        modelCount: storedMeta.modelCount,
        etag: res.etag ?? storedMeta.etag,
        digest: res.digest,
        message,
      };
    }

    const before = readCatalogCache(home)?.catalog;
    const cacheFile = catalogCachePath(home);
    if (opts.assertCacheWrite) await opts.assertCacheWrite(cacheFile);
    writeCatalogCache(
      res.catalog,
      {
        updatedAt: nowMs,
        fetchedAt: nowIso,
        source: force ? "refresh" : "poll",
        etag: res.etag,
        digest: res.digest,
      },
      home,
    );
    const providerCount = Object.keys(res.catalog.providers).length;
    const modelCount = countCatalogModels(res.catalog);
    const diff = before !== undefined ? summarizeCatalogDiff(before, res.catalog) : undefined;
    const revision = getCatalogCacheRevision();
    opts.onCacheUpdated?.({ revision, providerCount, diff });
    const message = `models catalog poll: refreshed (${providerCount} providers, ${modelCount} models)${diff !== undefined ? ` — ${diff}` : ""} — next turn uses cache (rev ${revision})`;
    opts.onNotice?.(message);
    return {
      status: "updated",
      providerCount,
      modelCount,
      etag: res.etag,
      digest: res.digest,
      diff,
      message,
    };
  } catch (err) {
    const message = `models catalog poll failed: ${err instanceof Error ? err.message : String(err)}`;
    opts.onNotice?.(message);
    return { status: "error", message };
  }
}

/** One conditional refresh (injected `fetchLive` for tests). */
export async function runModelsCatalogPollOnce(opts: ModelsCatalogPollOpts = {}): Promise<void> {
  await refreshModelsCatalog(opts);
}

/** In-flight single-flight tracker for non-blocking boot refreshes (keyed by home). */
const bootRefreshInFlight = new Map<string, Promise<RefreshModelsCatalogResult>>();

/**
 * Non-blocking fire-and-forget boot catalog refresh for `main.ts` (Track 5).
 * Returns immediately — never blocks CLI or TUI startup. Skipped when
 * `HZ_DISABLE_MODELS_FETCH=1` or `HZ_MODELS_PATH` is set.
 */
export function triggerBootCatalogRefresh(opts: RefreshModelsCatalogOpts = {}): void {
  const env = opts.env ?? process.env;
  if (isModelsFetchDisabled(env) || resolveModelsPath(env) !== undefined) return;
  const home = opts.home ?? homedir();
  if (bootRefreshInFlight.has(home)) return;
  const task = refreshModelsCatalog({ ...opts, home, env, force: false })
    .catch((err): RefreshModelsCatalogResult => {
      const message = `models catalog boot refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      opts.onNotice?.(message);
      return { status: "error", message };
    })
    .finally(() => {
      bootRefreshInFlight.delete(home);
    });
  bootRefreshInFlight.set(home, task);
}

/**
 * Start a background poll when interval is set. Returns `stop()`; no-op when
 * disabled. Uses `.unref()` so the timer NEVER prevents CLI exit.
 */
export function startModelsCatalogPoll(
  opts: ModelsCatalogPollOpts & {
    intervalMs?: number;
  } = {},
): ModelsPollStop {
  const env = opts.env ?? process.env;
  if (isModelsFetchDisabled(env) || resolveModelsPath(env) !== undefined) return () => undefined;
  const intervalMs = opts.intervalMs ?? parseModelsPollIntervalMs(env);
  if (intervalMs === undefined) return () => undefined;
  const home = opts.home ?? homedir();
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await runModelsCatalogPollOnce(opts);
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  // Sanity: first tick only after one interval (no surprise network at start).
  void loadCatalog(env, home);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

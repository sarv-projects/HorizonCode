/**
 * Optional periodic models.dev refresh (docs/30 §8 #9 reduced).
 *
 * Off unless `HZ_MODELS_POLL_MS` is a positive integer. Never runs in tests by
 * default; callers supply `fetchLive` for injection.
 */

import { homedir } from "node:os";
import type { GuardDecision } from "../../contracts";
import {
  CATALOG_PATH,
  DEFAULT_CATALOG_SOURCE,
  type CatalogFetchGuard,
  fetchLiveCatalog,
  getCatalogCacheRevision,
  loadCatalog,
  readCatalogCache,
  summarizeCatalogDiff,
  writeCatalogCache,
} from "./catalog";

export function modelsCatalogFetchUrl(source: string = DEFAULT_CATALOG_SOURCE): string {
  return source.replace(/\/+$/, "") + CATALOG_PATH;
}

/** Fail-closed guard hook for runtime poll (`net.fetch`; background cannot `ask`). */
export function makeModelsCatalogPollNetGuard(
  checkNetFetch: (url: string) => Promise<GuardDecision>,
): CatalogFetchGuard {
  const expected = modelsCatalogFetchUrl();
  return async (url: string) => {
    if (url !== expected) throw new Error(`unexpected catalog URL: ${url}`);
    const guard = await checkNetFetch(url);
    if (guard.decision === "deny") {
      throw new Error(`net.fetch denied — ${guard.reason ?? "egress policy"}`);
    }
    if (guard.decision === "ask") {
      throw new Error("net.fetch requires approval (background poll cannot prompt)");
    }
  };
}

export function parseModelsPollIntervalMs(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): number | undefined {
  const raw = typeof env.HZ_MODELS_POLL_MS === "string" ? env.HZ_MODELS_POLL_MS.trim() : "";
  if (raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60_000) return undefined;
  return n;
}

export type ModelsPollStop = () => void;

export type ModelsCatalogPollOpts = {
  home?: string;
  onNotice?: (message: string) => void;
  /** Fired after a successful cache write (revision + diff summary). */
  onCacheUpdated?: (info: { revision: number; providerCount: number; diff?: string }) => void;
  fetchLive?: typeof fetchLiveCatalog;
  /** Consulted before HTTP (runtime wires kernel `net.fetch`). */
  assertNetFetch?: CatalogFetchGuard;
};

/** One conditional refresh (injected `fetchLive` for tests). */
export async function runModelsCatalogPollOnce(opts: ModelsCatalogPollOpts = {}): Promise<void> {
  const home = opts.home ?? homedir();
  try {
    const cached = readCatalogCache(home);
    const etag = cached?.meta.etag;
    const res =
      opts.fetchLive !== undefined && opts.fetchLive !== fetchLiveCatalog
        ? await (async () => {
            if (opts.assertNetFetch) await opts.assertNetFetch(modelsCatalogFetchUrl());
            return opts.fetchLive!(undefined, { etag });
          })()
        : await fetchLiveCatalog(undefined, { etag, assertNetFetch: opts.assertNetFetch });
    if (res.notModified) {
      opts.onNotice?.("models catalog poll: not modified");
      return;
    }
    const before = cached?.catalog;
    if (res.digest !== undefined && res.digest === cached?.meta.digest) {
      // Same bytes under a new ETag: refresh the timestamp in memory only, no
      // rewrite and no cache-revision bump (opencode digest-equality policy).
      opts.onNotice?.("models catalog poll: body unchanged (same digest)");
      return;
    }
    writeCatalogCache(
      res.catalog,
      { fetchedAt: new Date().toISOString(), source: "poll", etag: res.etag, digest: res.digest },
      home,
    );
    const count = Object.keys(res.catalog.providers).length;
    const diff = before !== undefined ? summarizeCatalogDiff(before, res.catalog) : undefined;
    const revision = getCatalogCacheRevision();
    opts.onCacheUpdated?.({ revision, providerCount: count, diff });
    opts.onNotice?.(
      `models catalog poll: refreshed (${count} providers)${diff !== undefined ? ` — ${diff}` : ""} — next turn uses cache (rev ${revision})`,
    );
  } catch (err) {
    opts.onNotice?.(`models catalog poll failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Start a background poll when interval is set. Returns `stop()`; no-op when
 * disabled. `onNotice` receives human-readable status lines only.
 */
export function startModelsCatalogPoll(
  opts: ModelsCatalogPollOpts & {
    intervalMs?: number;
  } = {},
): ModelsPollStop {
  const intervalMs = opts.intervalMs ?? parseModelsPollIntervalMs();
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
  void loadCatalog({}, home);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

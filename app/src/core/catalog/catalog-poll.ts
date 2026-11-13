/**
 * Optional periodic models.dev refresh (docs/30 §8 #9 reduced).
 *
 * Off unless `HZ_MODELS_POLL_MS` is a positive integer. Never runs in tests by
 * default; callers supply `fetchLive` for injection.
 */

import { homedir } from "node:os";
import { fetchLiveCatalog, loadCatalog, readCatalogCache, writeCatalogCache } from "./catalog";

export function parseModelsPollIntervalMs(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): number | undefined {
  const raw = typeof env.HZ_MODELS_POLL_MS === "string" ? env.HZ_MODELS_POLL_MS.trim() : "";
  if (raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60_000) return undefined;
  return n;
}

export type ModelsPollStop = () => void;

/**
 * Start a background poll when interval is set. Returns `stop()`; no-op when
 * disabled. `onNotice` receives human-readable status lines only.
 */
export function startModelsCatalogPoll(opts: {
  home?: string;
  intervalMs?: number;
  onNotice?: (message: string) => void;
  fetchLive?: typeof fetchLiveCatalog;
} = {}): ModelsPollStop {
  const intervalMs = opts.intervalMs ?? parseModelsPollIntervalMs();
  if (intervalMs === undefined) return () => undefined;
  const home = opts.home ?? homedir();
  const fetchLive = opts.fetchLive ?? fetchLiveCatalog;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cached = readCatalogCache(home);
      const res = await fetchLive(undefined, { etag: cached?.meta.etag });
      if (res.notModified) {
        opts.onNotice?.("models catalog poll: not modified");
        return;
      }
      writeCatalogCache(res.catalog, { fetchedAt: new Date().toISOString(), source: "poll", etag: res.etag }, home);
      const count = Object.keys(res.catalog.providers).length;
      opts.onNotice?.(`models catalog poll: refreshed (${count} providers)`);
    } catch (err) {
      opts.onNotice?.(`models catalog poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

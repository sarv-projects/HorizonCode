/**
 * cache-warmth.ts — pure break-even math for an Anthropic-style prompt-cache
 * TTL (audit pass3, aider "cache keep-alive pings").
 *
 * This module is deliberately PURE: no timers, no HTTP, no provider calls. It
 * answers one question and one question only — "if the cache entry expires in
 * `remainingSeconds`, is paying for a one-token re-send to keep it warm cheaper
 * than paying the full cache-write again when the human resumes?"
 *
 *   C_ping      = prefix/1M * cached_read_price + 1 output token
 *   C_rehydrate = prefix/1M * write_price
 *   ping when   p_resume * (C_rehydrate - C_ping) > C_ping
 *
 * The break-even resume probability is therefore C_ping / (C_rehydrate -
 * C_ping) when the spread is positive; no probability can justify a ping when
 * rehydrating is cheaper than (or equal to) pinging.
 *
 * AUTO-PING IS AN OWNER CALL. Nothing here schedules a heartbeat, starts a
 * timer or sends anything on the wire. The companion stub
 * (`anthropic-cache-keepalive.ts`) stays a no-op notice; this module only
 * supplies the arithmetic and an optional status-bar segment so a human/owner
 * can make the decision with the numbers in front of them.
 */

import type { Catalog } from "../catalog/catalog";
import { resolveRates } from "../usage-cost";

const PER_M = 1_000_000;

export type CacheWarmthDecision = "ping_profitable" | "freeze" | "unknown";

export interface CacheWarmthInput {
  /** Cacheable prefix size in tokens. */
  prefixTokens: number;
  /** Per-1M-token cached-read (cache hit) price in USD. */
  cachedReadPricePerM: number;
  /** Per-1M-token cache-write price in USD. */
  writePricePerM: number;
  /** Per-1M-token output price in USD; one output token costs this / 1M. */
  outputPricePerM: number;
  /** Provider cache TTL in seconds. */
  ttlSeconds: number;
  /** Seconds elapsed since the cache entry was written. */
  elapsedSeconds: number;
  /** Probability the human resumes before TTL, in [0,1]. Absent => unknown. */
  pResume?: number;
}

export interface CacheWarmthResult {
  /** Cost of a one-token warming ping (a cache read of the prefix + 1 out token). */
  cPing: number;
  /** Cost of rebuilding the cache from scratch on resume (a full cache write). */
  cRehydrate: number;
  /** Resume probability at which a ping exactly breaks even; undefined when the spread <= 0. */
  breakEvenResumeProbability: number | undefined;
  /** remaining / TTL, clamped to [0,1]. */
  warmthFraction: number;
  /** max(0, ttl - elapsed). */
  remainingSeconds: number;
  decision: CacheWarmthDecision;
}

const UNKNOWN: CacheWarmthResult = {
  cPing: 0,
  cRehydrate: 0,
  breakEvenResumeProbability: undefined,
  warmthFraction: 0,
  remainingSeconds: 0,
  decision: "unknown",
};

/**
 * Pure warmth arithmetic. Unusable inputs (non-finite or negative prices /
 * counts) collapse to `unknown` with zero costs — a missing rate must never be
 * mistaken for a free cache.
 */
export function computeCacheWarmth(input: CacheWarmthInput): CacheWarmthResult {
  const { prefixTokens, cachedReadPricePerM, writePricePerM, outputPricePerM, ttlSeconds, elapsedSeconds, pResume } = input;
  const usable = [prefixTokens, cachedReadPricePerM, writePricePerM, outputPricePerM, ttlSeconds, elapsedSeconds].every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
  if (!usable) return { ...UNKNOWN };

  const prefixPerM = prefixTokens / PER_M;
  const cPing = prefixPerM * cachedReadPricePerM + outputPricePerM / PER_M;
  const cRehydrate = prefixPerM * writePricePerM;
  const remainingSeconds = Math.max(0, ttlSeconds - elapsedSeconds);
  const warmthFraction = ttlSeconds > 0 ? Math.min(1, Math.max(0, remainingSeconds / ttlSeconds)) : 0;

  const spread = cRehydrate - cPing;
  const breakEvenResumeProbability = spread > 0 ? cPing / spread : undefined;

  let decision: CacheWarmthDecision;
  if (pResume === undefined || !Number.isFinite(pResume) || pResume < 0 || pResume > 1) {
    // No resume estimate: we cannot compare expected costs.
    decision = "unknown";
  } else if (remainingSeconds <= 0) {
    // An already-expired entry cannot be warmed; freeze and let it lapse.
    decision = "freeze";
  } else if (breakEvenResumeProbability !== undefined && pResume > breakEvenResumeProbability) {
    decision = "ping_profitable";
  } else {
    decision = "freeze";
  }

  return { cPing, cRehydrate, breakEvenResumeProbability, warmthFraction, remainingSeconds, decision };
}

export interface CacheWarmthForModelInput {
  prefixTokens: number;
  provider: string;
  model: string;
  ttlSeconds: number;
  elapsedSeconds: number;
  pResume?: number;
  /**
   * Explicit catalog; when absent the process-local catalog registered with
   * `setCostCatalog` is used (via `resolveRates`). When neither exists the
   * harness table is the fallback. No network is touched.
   */
  catalog?: Catalog;
}

export interface CacheWarmthForModelResult extends CacheWarmthResult {
  /** Which price table produced the rates (`harness-v1` or `models.dev-v1:...`). */
  priceTableRevision: string;
}

/**
 * Model-aware wrapper. `resolveRates` consults `ratesForModelFromCatalog` for
 * the catalog seam and falls back to the harness table; this function only
 * forwards the resolved prices to the pure arithmetic above.
 */
export function cacheWarmthForModel(input: CacheWarmthForModelInput): CacheWarmthForModelResult {
  const { rates, revision } = resolveRates(input.provider, input.model, input.catalog);
  const result = computeCacheWarmth({
    prefixTokens: input.prefixTokens,
    cachedReadPricePerM: rates.cacheReadPerM ?? 0,
    writePricePerM: rates.cacheWritePerM ?? 0,
    outputPricePerM: rates.outputPerM,
    ttlSeconds: input.ttlSeconds,
    elapsedSeconds: input.elapsedSeconds,
    pResume: input.pResume,
  });
  return { ...result, priceTableRevision: revision };
}

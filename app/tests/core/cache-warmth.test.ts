/**
 * cache-warmth.test.ts — pure TTL break-even arithmetic (no timers, no network)
 * and the compact status-bar segment.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { computeCacheWarmth, cacheWarmthForModel } from "../../src/core/providers/cache-warmth";
import { setCostCatalog, HARNESS_PRICE_TABLE_REVISION } from "../../src/core/usage-cost";
import type { Catalog } from "../../src/core/catalog/catalog";
import {
  cacheWarmthDisplayEnabled,
  composeStatusBar,
  formatCacheWarmthStatus,
  type StatusInfo,
} from "../../src/tui/live";
import { colorEnabled, setColorEnabled, strip } from "../../src/tui/style";

function composeStatusBarWithWarmth(info: Omit<StatusInfo, "cacheWarmth">, state: StatusInfo["cacheWarmth"]): string {
  return composeStatusBar({ ...info, cacheWarmth: state }, 120);
}

describe("computeCacheWarmth", () => {
  test("exact formulas: C_ping, C_rehydrate, break-even, warmth, remaining", () => {
    const r = computeCacheWarmth({
      prefixTokens: 1_000_000,
      cachedReadPricePerM: 0.3,
      writePricePerM: 3.75,
      outputPricePerM: 15,
      ttlSeconds: 300,
      elapsedSeconds: 60,
      pResume: 0.5,
    });
    expect(r.cPing).toBeCloseTo(0.3 + 15 / 1_000_000, 12);
    expect(r.cRehydrate).toBeCloseTo(3.75, 12);
    expect(r.breakEvenResumeProbability).toBeCloseTo((0.3 + 15e-6) / (3.75 - (0.3 + 15e-6)), 9);
    expect(r.warmthFraction).toBeCloseTo(0.8, 12);
    expect(r.remainingSeconds).toBe(240);
    expect(r.decision).toBe("ping_profitable");
  });

  test("p_resume exactly at break-even is a freeze (strict inequality) and just above profits", () => {
    const base = {
      prefixTokens: 50_000,
      cachedReadPricePerM: 0.3,
      writePricePerM: 3.75,
      outputPricePerM: 15,
      ttlSeconds: 300,
      elapsedSeconds: 10,
    };
    const probe = computeCacheWarmth({ ...base, pResume: 0.5 });
    const p = probe.breakEvenResumeProbability!;
    expect(Number.isFinite(p)).toBe(true);
    expect(computeCacheWarmth({ ...base, pResume: p }).decision).toBe("freeze");
    expect(computeCacheWarmth({ ...base, pResume: p + 0.001 }).decision).toBe("ping_profitable");
  });

  test("zero prices: no spread so break-even is undefined and the decision is freeze", () => {
    const r = computeCacheWarmth({
      prefixTokens: 1_000,
      cachedReadPricePerM: 0,
      writePricePerM: 0,
      outputPricePerM: 0,
      ttlSeconds: 300,
      elapsedSeconds: 0,
      pResume: 1,
    });
    expect(r.cPing).toBe(0);
    expect(r.cRehydrate).toBe(0);
    expect(r.breakEvenResumeProbability).toBeUndefined();
    expect(r.warmthFraction).toBe(1);
    expect(r.decision).toBe("freeze");
  });

  test("TTL elapsed: remaining and warmth clamp to zero, decision freezes", () => {
    const r = computeCacheWarmth({
      prefixTokens: 1_000,
      cachedReadPricePerM: 0.3,
      writePricePerM: 3.75,
      outputPricePerM: 15,
      ttlSeconds: 300,
      elapsedSeconds: 400,
      pResume: 0.99,
    });
    expect(r.remainingSeconds).toBe(0);
    expect(r.warmthFraction).toBe(0);
    expect(r.decision).toBe("freeze");
  });

  test("missing rates (non-finite price) collapse to unknown with zero costs", () => {
    const r = computeCacheWarmth({
      prefixTokens: 1_000,
      cachedReadPricePerM: Number.NaN,
      writePricePerM: 3.75,
      outputPricePerM: 15,
      ttlSeconds: 300,
      elapsedSeconds: 0,
      pResume: 1,
    });
    expect(r.decision).toBe("unknown");
    expect(r.cPing).toBe(0);
    expect(r.cRehydrate).toBe(0);
    expect(r.breakEvenResumeProbability).toBeUndefined();
  });

  test("missing or invalid p_resume is unknown; rehydrate cheaper than ping never profits", () => {
    const base = {
      prefixTokens: 1_000,
      cachedReadPricePerM: 10,
      writePricePerM: 0.1,
      outputPricePerM: 15,
      ttlSeconds: 300,
      elapsedSeconds: 0,
    };
    expect(computeCacheWarmth(base).decision).toBe("unknown");
    expect(computeCacheWarmth({ ...base, pResume: 1.5 }).decision).toBe("unknown");
    const cheap = computeCacheWarmth({ ...base, pResume: 1 });
    expect(cheap.breakEvenResumeProbability).toBeUndefined();
    expect(cheap.decision).toBe("freeze");
  });
});

describe("cacheWarmthForModel (catalog seam, no network)", () => {
  test("falls back to the harness table when no catalog is registered", () => {
    setCostCatalog(undefined);
    const r = cacheWarmthForModel({
      prefixTokens: 1_000_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      ttlSeconds: 300,
      elapsedSeconds: 0,
      pResume: 0.5,
    });
    expect(r.priceTableRevision).toBe(HARNESS_PRICE_TABLE_REVISION);
    expect(r.cPing).toBeCloseTo(0.3 + 15e-6, 12);
    expect(r.cRehydrate).toBeCloseTo(3.75, 12);
  });

  test("a registered catalog supplies the rates (explicit zero is honored)", () => {
    const catalog: Catalog = {
      providers: {
        vendor: {
          id: "vendor",
          defaultModel: "m",
          models: {
            m: {
              id: "m",
              provider: "vendor",
              limit: { context: 1000 },
              cost: { input: 1, output: 2, cacheReadPerM: 0, cacheWritePerM: 5 },
            },
          },
        },
      },
      rejected: [],
    };
    setCostCatalog(catalog);
    try {
      const r = cacheWarmthForModel({
        prefixTokens: 1_000_000,
        provider: "vendor",
        model: "m",
        ttlSeconds: 300,
        elapsedSeconds: 30,
        pResume: 0.1,
      });
      expect(r.priceTableRevision).toBe("models.dev-v1:vendor/m");
      expect(r.cPing).toBeCloseTo(2e-6, 12); // cached-read price 0 is real, not missing
      expect(r.cRehydrate).toBeCloseTo(5, 12);
      expect(r.breakEvenResumeProbability).toBeCloseTo(2e-6 / 5, 12);
      expect(r.decision).toBe("ping_profitable");
    } finally {
      setCostCatalog(undefined);
    }
  });
});

describe("cache warmth status segment", () => {
  let wasColor = false;
  beforeAll(() => {
    wasColor = colorEnabled();
    setColorEnabled(false);
  });
  afterAll(() => setColorEnabled(wasColor));

  test("format is compact with a decision marker", () => {
    expect(formatCacheWarmthStatus({ warmthFraction: 0.73, remainingSeconds: 90, decision: "ping_profitable" })).toBe(
      "warm 73%/1m30s+",
    );
    expect(formatCacheWarmthStatus({ warmthFraction: 0.2, remainingSeconds: 40, decision: "freeze" })).toBe(
      "warm 20%/40s-",
    );
    expect(formatCacheWarmthStatus({ warmthFraction: 0, remainingSeconds: 0, decision: "unknown" })).toBe("warm 0%/0s?");
  });

  test("display opt-in flag is exact", () => {
    expect(cacheWarmthDisplayEnabled({ HZ_CACHE_WARMTH: "1" })).toBe(true);
    expect(cacheWarmthDisplayEnabled({ HZ_CACHE_WARMTH: "0" })).toBe(false);
    expect(cacheWarmthDisplayEnabled({})).toBe(false);
  });

  test("status bar hides the segment unless both state and flag are present", () => {
    const prior = process.env.HZ_CACHE_WARMTH;
    const info = { badge: "", model: "m", provider: "p", path: "~/x" };
    const state = { warmthFraction: 0.5, remainingSeconds: 150, decision: "freeze" as const };
    try {
      delete process.env.HZ_CACHE_WARMTH;
      expect(strip(composeStatusBarWithWarmth(info, state))).not.toContain("warm");
      process.env.HZ_CACHE_WARMTH = "1";
      expect(strip(composeStatusBarWithWarmth(info, state))).toContain("warm 50%/2m30s-");
      expect(strip(composeStatusBarWithWarmth(info, undefined))).not.toContain("warm");
    } finally {
      if (prior === undefined) delete process.env.HZ_CACHE_WARMTH;
      else process.env.HZ_CACHE_WARMTH = prior;
    }
  });
});

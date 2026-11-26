/**
 * circuit-breaker.test.ts — full tri-state provider circuit breaker ported
 * from grok xai-circuit-breaker (Tier 1 #8). Test-first: fails on missing module.
 *
 * Covers: monotonic baseline, isOpenFast mirror, sliding-window trip,
 * half-open probe slots, abandoned-probe lease reclamation (the CAS trick),
 * Retry-After, and the registry keyed by route token.
 */
import { describe, expect, test } from "bun:test";
import {
  BreakerOpenError,
  CircuitBreaker,
  BreakerRegistry,
  type BreakerConfig,
} from "../../src/core/providers/circuit-breaker";
import { fetchWithRetry } from "../../src/core/providers/retry";

// Deterministic injected clock with a monotonic baseline.
function clock() {
  let ms = 1000;
  return {
    now: () => ms,
    advance: (d: number) => {
      ms += d;
    },
  };
}

function config(over: Partial<BreakerConfig> = {}): BreakerConfig {
  return {
    windowDurationMs: 60_000,
    minSamples: 4,
    errorRateThreshold: 0.5,
    openDurationMs: 10_000,
    halfOpenMaxProbes: 1,
    failureStatuses: [429, 500, 502, 503, 504],
    enabled: true,
    ...over,
  };
}

describe("provider circuit breaker (grok port)", () => {
  test("trip after threshold failures; isOpenFast mirrors state; check sheds with Retry-After", () => {
    const c = clock();
    const b = new CircuitBreaker(config(), { now: c.now });
    expect(b.state()).toBe("closed");
    expect(b.isOpenFast()).toBe(false);
    for (let i = 0; i < 4; i++) b.record("failure");
    expect(b.state()).toBe("open");
    expect(b.isOpenFast()).toBe(true);
    expect(() => b.check()).toThrow(BreakerOpenError);
    try {
      b.check();
    } catch (err) {
      expect((err as BreakerOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((err as BreakerOpenError).retryAfterMs).toBeLessThanOrEqual(10_000);
    }
  });

  test("open -> half_open after cooldown via monotonic clock; one probe admitted", () => {
    const c = clock();
    const b = new CircuitBreaker(config(), { now: c.now });
    for (let i = 0; i < 4; i++) b.record("failure");
    expect(b.state()).toBe("open");
    c.advance(10_001);
    expect(b.check()).toBeUndefined(); // first probe admitted
    expect(b.state()).toBe("half_open");
    expect(b.isOpenFast()).toBe(false);
    // second caller is refused (single probe slot) with a short backoff
    try {
      b.check();
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(BreakerOpenError);
      expect((err as BreakerOpenError).retryAfterMs).toBeLessThanOrEqual(50);
    }
    b.record("success");
    expect(b.state()).toBe("closed");
    expect(b.isOpenFast()).toBe(false);
  });

  test("a failed probe re-trips with a fresh deadline", () => {
    const c = clock();
    const b = new CircuitBreaker(config(), { now: c.now });
    for (let i = 0; i < 4; i++) b.record("failure");
    c.advance(10_001);
    b.check();
    b.record("failure");
    expect(b.state()).toBe("open");
    expect(b.isOpenFast()).toBe(true);
    c.advance(10_001);
    expect(b.check()).toBeUndefined();
  });

  test("abandoned half-open probe is reclaimed after one lease window (CAS reclamation)", () => {
    const c = clock();
    const b = new CircuitBreaker(config({ openDurationMs: 1000 }), { now: c.now });
    for (let i = 0; i < 4; i++) b.record("failure");
    c.advance(1001);
    expect(b.check()).toBeUndefined(); // probe claimed, owner cancelled, never records
    expect(() => b.check()).toThrow(BreakerOpenError); // slot held
    c.advance(1000); // lease expired
    expect(b.check()).toBeUndefined(); // exactly one caller reclaims
  });

  test("disabled breaker always passes; failure-status classification is data-driven", () => {
    const c = clock();
    const b = new CircuitBreaker(config({ enabled: false }), { now: c.now });
    for (let i = 0; i < 100; i++) b.record("failure");
    expect(b.check()).toBeUndefined();
    const b2 = new CircuitBreaker(config(), { now: c.now });
    expect(b2.isFailureStatus(429)).toBe(true);
    expect(b2.isFailureStatus(200)).toBe(false);
  });

  test("registry isolates routes and resets cleanly", () => {
    const c = clock();
    const reg = new BreakerRegistry(config(), { now: c.now });
    const a = reg.forRoute("route-a");
    const b = reg.forRoute("route-b");
    expect(a).not.toBe(b);
    for (let i = 0; i < 4; i++) a.record("failure");
    expect(a.state()).toBe("open");
    expect(b.state()).toBe("closed");
    reg.clear();
    expect(reg.forRoute("route-a").state()).toBe("closed");
  });

  test("END-TO-END: fetchWithRetry consults the breaker and records outcomes", async () => {
    const c = clock();
    const b = new CircuitBreaker(config({ minSamples: 2, enabled: true }), { now: c.now });
    const realFetch = globalThis.fetch;
    let calls = 0;
    // @ts-expect-error test double
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("err", { status: 503 });
    };
    try {
      // Two failed HTTP responses trip the breaker (minSamples=2).
      await fetchWithRetry("https://example.invalid", {}, { breaker: b, attempts: 1, baseDelayMs: 1 });
      await fetchWithRetry("https://example.invalid", {}, { breaker: b, attempts: 1, baseDelayMs: 1 });
      expect(calls).toBe(2);
      expect(b.state()).toBe("open");
      // Third call is shed without touching the network.
      await expect(
        fetchWithRetry("https://example.invalid", {}, { breaker: b, attempts: 1 }),
      ).rejects.toBeInstanceOf(BreakerOpenError);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("error rate uses a monotonic sliding window; eviction prevents stale trips", () => {
    const c = clock();
    const b = new CircuitBreaker(
      config({ windowDurationMs: 500, minSamples: 2, errorRateThreshold: 0.5 }),
      { now: c.now },
    );
    b.record("success");
    b.record("failure");
    expect(b.errorRate()).toBeCloseTo(0.5);
    c.advance(501);
    expect(b.errorRate()).toBe(0);
  });
});

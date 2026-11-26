/**
 * circuit-breaker.ts — tri-state provider circuit breaker.
 *
 * Full port of grok xai-circuit-breaker (breaker.rs, state.rs, config.rs,
 * window.rs) at pinned repo_take/grok-build @ 2bdd1d6. Adapted to TS/Bun:
 *
 *   - three states Closed/Open/HalfOpen with a LOCK-FREE `isOpenFast` mirror
 *     (the hot shed path never takes the window lock);
 *   - a MONOTONIC baseline (`now() - baseline`) so NTP steps cannot move the
 *     cooldown — the injected clock makes this deterministic in tests;
 *   - a sliding window with min-samples + error-rate threshold;
 *   - HALF-OPEN PROBE SLOTS with abandoned-lease reclamation: a probe whose
 *     owner was cancelled before `record()` is reclaimed by exactly one caller
 *     (CAS on the claim timestamp) after one `openDuration`, so a lost probe
 *     cannot strand the breaker in HalfOpen forever;
 *   - `BreakerOpenError.retryAfterMs`, with a short fixed backoff for
 *     slot-exhausted half-open rejections (never the full cooldown);
 *   - a per-route registry for endpoint/tenant-keyed breakers.
 *
 * NO embeddings, no network, no authority change. Advisory shedding only —
 * all defaults can be disabled; when disabled the breaker always passes.
 */

export type BreakerState = "closed" | "open" | "half_open";
export type BreakerOutcome = "success" | "failure";

export interface BreakerConfig {
  windowDurationMs: number;
  minSamples: number;
  errorRateThreshold: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
  failureStatuses: readonly number[];
  enabled: boolean;
}

export const SERVER_BREAKER_CONFIG: BreakerConfig = {
  windowDurationMs: 60_000,
  minSamples: 10,
  errorRateThreshold: 0.5,
  openDurationMs: 10_000,
  halfOpenMaxProbes: 1,
  failureStatuses: [429, 500, 502, 503, 504],
  enabled: true,
};

export const CLIENT_BREAKER_CONFIG: BreakerConfig = {
  ...SERVER_BREAKER_CONFIG,
  minSamples: 5,
  openDurationMs: 60_000,
  failureStatuses: [401],
};

export class BreakerOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`circuit breaker open; retry after ${(retryAfterMs / 1000).toFixed(1)}s`);
    this.name = "BreakerOpenError";
  }
}

interface Sample {
  at: number;
  failure: boolean;
}

interface ClockLike {
  now(): number;
}

const HALF_OPEN_PROBE_BACKOFF_MS = 50;

const DEFAULT_MONOTONIC_CLOCK: ClockLike = {
  now: () => performance.now(),
};

/**
 * A single breaker. `now()` is injected; the baseline is captured at
 * construction so every stored timestamp is an offset from it (NTP-safe).
 */
export class CircuitBreaker {
  private stateValue: BreakerState = "closed";
  private isOpenFastValue = false;
  private openedAt = 0;
  private halfOpenProbes = 0;
  private probeClaimedAt = 0;
  private readonly baseline: number;
  private readonly window: Sample[] = [];
  private readonly clock: ClockLike;
  private readonly cfg: BreakerConfig;

  constructor(config: BreakerConfig = SERVER_BREAKER_CONFIG, clock: ClockLike = DEFAULT_MONOTONIC_CLOCK) {
    this.cfg = { ...config };
    this.cfg.halfOpenMaxProbes = Math.max(1, this.cfg.halfOpenMaxProbes);
    this.clock = clock;
    this.baseline = clock.now();
  }

  state(): BreakerState {
    return this.stateValue;
  }

  /** Lock-free mirror of `state === "open"` for the hot shed path. */
  isOpenFast(): boolean {
    return this.isOpenFastValue;
  }

  config(): Readonly<BreakerConfig> {
    return this.cfg;
  }

  isFailureStatus(status: number): boolean {
    return this.cfg.failureStatuses.includes(status);
  }

  /** Milliseconds elapsed against the monotonic baseline. */
  private elapsed(): number {
    return Math.max(0, this.clock.now() - this.baseline);
  }

  private evictWindow(): void {
    const cutoff = this.elapsed() - this.cfg.windowDurationMs;
    while (this.window.length > 0 && this.window[0]!.at < cutoff) this.window.shift();
  }

  errorRate(): number {
    this.evictWindow();
    if (this.window.length === 0) return 0;
    const failures = this.window.reduce((n, s) => n + (s.failure ? 1 : 0), 0);
    return failures / this.window.length;
  }

  /** Consult before a request. Throws BreakerOpenError when shedding. */
  check(): void {
    if (!this.cfg.enabled) return;
    switch (this.stateValue) {
      case "closed":
        return;
      case "open":
        this.checkOpen();
        return;
      case "half_open":
        this.tryHalfOpenProbe();
        return;
    }
  }

  private checkOpen(): void {
    const elapsed = this.elapsed() - this.openedAt;
    if (elapsed >= this.cfg.openDurationMs) {
      // CAS-equivalent: single-threaded JS, so the transition is atomic.
      this.stateValue = "half_open";
      this.isOpenFastValue = false;
      // Do NOT reset halfOpenProbes here: trip() zeroed it on Open entry and
      // nothing increments it while Open; resetting races a HalfOpen observer.
      this.tryHalfOpenProbe();
      return;
    }
    throw new BreakerOpenError(Math.max(1, this.cfg.openDurationMs - elapsed));
  }

  private tryHalfOpenProbe(): void {
    if (this.halfOpenProbes < this.cfg.halfOpenMaxProbes) {
      this.halfOpenProbes += 1;
      this.probeClaimedAt = this.elapsed();
      return;
    }
    // All slots claimed. A claim is released only by record(); if the owner
    // was cancelled before recording, reclaim exactly one after one lease.
    const lease = this.cfg.openDurationMs;
    if (this.elapsed() - this.probeClaimedAt >= lease) {
      this.probeClaimedAt = this.elapsed();
      return;
    }
    throw new BreakerOpenError(Math.min(HALF_OPEN_PROBE_BACKOFF_MS, this.cfg.openDurationMs));
  }

  record(outcome: BreakerOutcome): void {
    if (!this.cfg.enabled) return;
    const failure = outcome === "failure";
    this.evictWindow();
    this.window.push({ at: this.elapsed(), failure });
    switch (this.stateValue) {
      case "closed": {
        const shouldTrip =
          this.window.length >= this.cfg.minSamples && this.errorRate() >= this.cfg.errorRateThreshold;
        if (shouldTrip) this.trip();
        break;
      }
      case "half_open":
        if (failure) this.trip();
        else this.close();
        break;
      case "open":
        // still record into the window while shedding (grok does this)
        break;
    }
  }

  private trip(): void {
    this.stateValue = "open";
    this.openedAt = this.elapsed();
    this.halfOpenProbes = 0;
    this.isOpenFastValue = true; // mirror written AFTER authoritative state
  }

  private close(): void {
    this.stateValue = "closed";
    this.window.length = 0;
    this.halfOpenProbes = 0;
    this.isOpenFastValue = false;
  }
}

const MAX_BREAKER_ROUTES = 256;

/** Per-route breaker registry (endpoint/tenant keyed). */
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: BreakerConfig = SERVER_BREAKER_CONFIG,
    private readonly clock: ClockLike = DEFAULT_MONOTONIC_CLOCK,
  ) {}

  forRoute(route: string): CircuitBreaker {
    let b = this.breakers.get(route);
    if (b === undefined) {
      if (this.breakers.size >= MAX_BREAKER_ROUTES) {
        const oldest = this.breakers.keys().next().value;
        if (oldest !== undefined) this.breakers.delete(oldest);
      }
      b = new CircuitBreaker(this.config, this.clock);
      this.breakers.set(route, b);
    }
    return b;
  }

  clear(): void {
    this.breakers.clear();
  }
}

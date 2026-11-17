/**
 * circuit-breakers.test.ts — experimental edit-cycle breakers (flag-gated).
 * Covers: canonical hash stability, two-strike halt, the 40% boundary, the
 * explicit-refactor bypass, and that EVERYTHING is inert by default.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CIRCUITS_FLAG,
  circuitsEnabled,
  CycleTracker,
  cycleHash,
  diffEntropyGuard,
  DIFF_ENTROPY_THRESHOLD,
  trackCycle,
} from "../../src/core/circuit-breakers";

const saved = process.env[CIRCUITS_FLAG];
beforeEach(() => {
  delete process.env[CIRCUITS_FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[CIRCUITS_FLAG];
  else process.env[CIRCUITS_FLAG] = saved;
});

function lines(n: number, prefix = "a"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");
}

describe("experimental circuit breakers — disabled by default", () => {
  test("the flag is off unless explicitly 1", () => {
    expect(circuitsEnabled()).toBe(false);
    process.env[CIRCUITS_FLAG] = "0";
    expect(circuitsEnabled()).toBe(false);
    process.env[CIRCUITS_FLAG] = "1";
    expect(circuitsEnabled()).toBe(true);
  });

  test("tracker records nothing and never halts when the flag is off", () => {
    const tracker = new CycleTracker();
    const first = trackCycle(tracker, "s1", ["foo"], ["TS1234"]);
    const second = trackCycle(tracker, "s1", ["foo"], ["TS1234"]);
    expect(first).toEqual({ halt: false, strikes: 0 });
    expect(second).toEqual({ halt: false, strikes: 0 });
    expect(tracker.size).toBe(0);
  });

  test("entropy guard never refuses when the flag is off", () => {
    const decision = diffEntropyGuard(lines(10), lines(10, "totally-different-"));
    expect(decision).toEqual({ allowed: true, changedRatio: 0, threshold: 0 });
  });
});

describe("cycleHash (pure, stable)", () => {
  test("order and duplicates do not change the digest", () => {
    const a = cycleHash(["b", "a", "b"], ["E2", "E1", "E2"]);
    const b = cycleHash(["a", "b"], ["E1", "E2"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a different symbol or error code changes the digest", () => {
    const base = cycleHash(["a"], ["E1"]);
    expect(cycleHash(["b"], ["E1"])).not.toBe(base);
    expect(cycleHash(["a"], ["E2"])).not.toBe(base);
  });

  test("hash is stable across repeated calls (canonical via canon.ts)", () => {
    expect(cycleHash(["x", "y"], ["TS100"])).toBe(cycleHash(["x", "y"], ["TS100"]));
  });
});

describe("two-strike halt (flag on)", () => {
  test("two identical consecutive states halt; a different state resets the count", () => {
    process.env[CIRCUITS_FLAG] = "1";
    const tracker = new CycleTracker();
    expect(tracker.trackCycle("s1", ["foo"], ["TS1"])).toEqual({ halt: false, strikes: 1 });
    expect(tracker.trackCycle("s1", ["foo"], ["TS1"])).toEqual({ halt: true, strikes: 2 });
    // A halted session stays halted until reset.
    expect(tracker.trackCycle("s1", ["bar"], ["TS2"]).halt).toBe(true);
    tracker.reset("s1");
    expect(tracker.trackCycle("s1", ["bar"], ["TS2"])).toEqual({ halt: false, strikes: 1 });
  });

  test("states are keyed per session", () => {
    process.env[CIRCUITS_FLAG] = "1";
    const tracker = new CycleTracker();
    expect(tracker.trackCycle("a", ["x"], ["E"]).strikes).toBe(1);
    expect(tracker.trackCycle("b", ["x"], ["E"]).strikes).toBe(1);
    expect(tracker.trackCycle("a", ["x"], ["E"])).toEqual({ halt: true, strikes: 2 });
  });

  test("tracker is bounded", () => {
    process.env[CIRCUITS_FLAG] = "1";
    const tracker = new CycleTracker(2);
    tracker.trackCycle("a", ["x"], []);
    tracker.trackCycle("b", ["y"], []);
    tracker.trackCycle("c", ["z"], []);
    expect(tracker.size).toBe(2);
  });
});

describe("diffEntropyGuard (flag on)", () => {
  test("40% is allowed; above 40% is refused", () => {
    process.env[CIRCUITS_FLAG] = "1";
    const before = lines(10);
    const atBoundary = before.split("\n").map((line, i) => (i < 4 ? "changed" : line)).join("\n");
    const overBoundary = before.split("\n").map((line, i) => (i < 5 ? "changed" : line)).join("\n");
    expect(DIFF_ENTROPY_THRESHOLD).toBe(0.4);
    const at = diffEntropyGuard(before, atBoundary);
    expect(at.allowed).toBe(true);
    expect(at.changedRatio).toBeCloseTo(0.4, 6);
    const over = diffEntropyGuard(before, overBoundary);
    expect(over.allowed).toBe(false);
    expect(over.changedRatio).toBeCloseTo(0.5, 6);
  });

  test("an explicit refactor directive bypasses the refusal", () => {
    process.env[CIRCUITS_FLAG] = "1";
    const before = lines(10);
    const rewrite = lines(10, "brand-new");
    expect(diffEntropyGuard(before, rewrite).allowed).toBe(false);
    const bypass = diffEntropyGuard(before, rewrite, { explicitRefactor: true });
    expect(bypass.allowed).toBe(true);
    expect(bypass.changedRatio).toBe(1);
  });

  test("identical files are a zero-ratio no-op", () => {
    process.env[CIRCUITS_FLAG] = "1";
    expect(diffEntropyGuard(lines(10), lines(10)).changedRatio).toBe(0);
  });
});

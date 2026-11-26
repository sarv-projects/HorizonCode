/**
 * memory-decay.test.ts -- store-day recency decay (plan Task 22).
 * Ranking only: no embeddings, no recency as a guard.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_RECALL_HALF_LIFE_DAYS, storeDayDecay } from "../../src/core/memory/decay";

describe("store-day decay", () => {
  test("halves at 30 days and clamps future timestamps", () => {
    const now = Date.parse("2026-11-21T00:00:00Z");
    const day = 86_400_000;
    expect(MEMORY_RECALL_HALF_LIFE_DAYS).toBe(30);
    expect(storeDayDecay(1, now, now)).toBe(1);
    expect(storeDayDecay(1, now - 30 * day, now)).toBeCloseTo(0.5);
    expect(storeDayDecay(1, now - 60 * day, now)).toBeCloseTo(0.25);
    expect(storeDayDecay(1, now + day, now)).toBe(1);
  });

  test("non-finite inputs and negative scores return zero", () => {
    const now = 1_000_000;
    expect(storeDayDecay(-1, 0, now)).toBe(0);
    expect(storeDayDecay(Number.NaN, 0, now)).toBe(0);
    expect(storeDayDecay(1, Number.NaN, now)).toBe(0);
    expect(storeDayDecay(1, 0, Number.NaN)).toBe(0);
    expect(storeDayDecay(1, 0, now, 0)).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  EMERGENCY_SHRINK_LADDER,
  emergencyHistoryLimit,
  isContextWindowExceededCode,
  nextImageRung,
} from "../../src/core/compaction-context-window";

describe("compaction-context-window", () => {
  test("isContextWindowExceededCode", () => {
    expect(isContextWindowExceededCode("CONTEXT_WINDOW_EXCEEDED")).toBe(true);
    expect(isContextWindowExceededCode("RATE_LIMIT")).toBe(false);
    expect(isContextWindowExceededCode(undefined)).toBe(false);
  });

  test("emergencyHistoryLimit shrinks when messages exceed next cap", () => {
    expect(emergencyHistoryLimit(80, 80)).toBe(68); // first rung is now 0.85
    expect(emergencyHistoryLimit(80, 50)).toBe(49);
    expect(emergencyHistoryLimit(10, 5)).toBe(4);
  });

  test("emergency shrink follows the four-step ladder", () => {
    expect(EMERGENCY_SHRINK_LADDER).toEqual([0.85, 0.7, 0.5, 0.35]);
    expect(emergencyHistoryLimit(100, 100, 0)).toBe(85);
    expect(emergencyHistoryLimit(100, 100, 1)).toBe(70);
    expect(emergencyHistoryLimit(100, 100, 2)).toBe(50);
    expect(emergencyHistoryLimit(100, 100, 3)).toBe(35);
    expect(emergencyHistoryLimit(100, 100, 99)).toBe(35); // clamped to last rung
    expect(emergencyHistoryLimit(100, 80, 0)).toBe(79); // message-count clamp preserved
    expect(emergencyHistoryLimit(1, 1, 0)).toBeNull();
  });

  test("image-budget hysteresis avoids flapping between rungs", () => {
    // Shrinks only past the low-water mark; recovers only past the high-water mark.
    expect(nextImageRung(0.51, 0)).toBe(0);
    expect(nextImageRung(0.49, 0)).toBe(1);
    expect(nextImageRung(0.49, 1)).toBe(2); // further shrink below the low-water mark
    expect(nextImageRung(0.69, 1)).toBe(1); // not enough headroom to recover (0.7)
    expect(nextImageRung(0.71, 1)).toBe(0); // recovered past high-water
  });

  test("emergencyHistoryLimit is null when already minimal", () => {
    expect(emergencyHistoryLimit(80, 1)).toBe(null);
    expect(emergencyHistoryLimit(2, 1)).toBe(null);
  });
});

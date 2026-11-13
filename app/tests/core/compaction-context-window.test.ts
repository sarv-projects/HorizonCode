import { describe, expect, test } from "bun:test";
import {
  emergencyHistoryLimit,
  isContextWindowExceededCode,
} from "../../src/core/compaction-context-window";

describe("compaction-context-window", () => {
  test("isContextWindowExceededCode", () => {
    expect(isContextWindowExceededCode("CONTEXT_WINDOW_EXCEEDED")).toBe(true);
    expect(isContextWindowExceededCode("RATE_LIMIT")).toBe(false);
    expect(isContextWindowExceededCode(undefined)).toBe(false);
  });

  test("emergencyHistoryLimit shrinks when messages exceed next cap", () => {
    expect(emergencyHistoryLimit(80, 80)).toBe(52);
    expect(emergencyHistoryLimit(80, 50)).toBe(49);
    expect(emergencyHistoryLimit(10, 5)).toBe(4);
  });

  test("emergencyHistoryLimit is null when already minimal", () => {
    expect(emergencyHistoryLimit(80, 1)).toBe(null);
    expect(emergencyHistoryLimit(2, 1)).toBe(null);
  });
});

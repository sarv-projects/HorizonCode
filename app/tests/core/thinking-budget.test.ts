/**
 * thinking-budget.test.ts — bounded thinking-token cap (course/clawspring ADAPT).
 * Pure per-turn accumulator: admits deltas up to a cap, then refuses further
 * thinking with a typed signal (caller decides how to surface it).
 */
import { describe, expect, test } from "bun:test";
import {
  createThinkingBudget,
  type ThinkingBudget,
} from "../../src/core/thinking-budget";

describe("thinking token budget", () => {
  test("admits deltas up to the cap then refuses", () => {
    const b: ThinkingBudget = createThinkingBudget({ capTokens: 10 });
    expect(b.add("a".repeat(20)).admitted).toBe(true); // 5 tokens (20 bytes / 4)
    expect(b.add("b".repeat(20)).admitted).toBe(true); // 10 total == cap -> exhausted
    expect(b.add("c".repeat(4)).admitted).toBe(false); // at cap, refused
    expect(b.usedTokens()).toBe(10);
    expect(b.remainingTokens()).toBe(0);
  });

  test("a delta that crosses the cap is clamped, not exceeded", () => {
    const b = createThinkingBudget({ capTokens: 10 });
    const r = b.add("x".repeat(200)); // 50 tokens > cap 10 -> clamped
    expect(r.admitted).toBe(true);
    expect(r.clamped).toBe(true);
    expect(b.usedTokens()).toBe(10);
  });

  test("estimateTokens is bytes/4, shared convention", () => {
    const b = createThinkingBudget({ capTokens: 100 });
    expect(b.estimate("abcd")).toBe(1);
    expect(b.estimate("abcdefgh")).toBe(2);
  });

  test("zero/negative cap is a typed precondition failure", () => {
    expect(() => createThinkingBudget({ capTokens: 0 })).toThrow(/cap/i);
    expect(() => createThinkingBudget({ capTokens: -1 })).toThrow(/cap/i);
  });
});

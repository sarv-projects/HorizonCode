/**
 * usage-invariant.test.ts -- pure Usage arithmetic validator (plan Task 6).
 * Absent fields are unknown, never guessed or fabricated.
 */
import { describe, expect, test } from "bun:test";
import {
  checkUsageInvariant,
  formatUsageInvariantNotice,
} from "../../src/core/providers/usage-invariant";

describe("usage invariant", () => {
  test("consistent usage passes; absent fields are not violations", () => {
    expect(checkUsageInvariant({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      nonCachedInputTokens: 60,
      totalTokens: 120,
    }).ok).toBe(true);
    expect(checkUsageInvariant({}).ok).toBe(true);
  });

  test("arithmetic violations are named by field", () => {
    const bad = checkUsageInvariant({
      inputTokens: 100,
      outputTokens: 20,
      nonCachedInputTokens: 90,
      totalTokens: 999,
      reasoningTokens: 21,
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations).toEqual(expect.arrayContaining([
      "nonCachedInputTokens", "totalTokens", "reasoningTokens",
    ]));
  });

  test("cache totals, cache-write aliases and negative/NaN values are checked", () => {
    expect(checkUsageInvariant({
      inputTokens: 50,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 20,
    }).violations).toContain("cacheInputTokens");
    expect(checkUsageInvariant({
      inputTokens: 50,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 10,
      nonCachedInputTokens: 0,
    }).ok).toBe(true);
    expect(checkUsageInvariant({ inputTokens: -1 }).violations).toContain("inputTokens");
    expect(checkUsageInvariant({ outputTokens: Number.NaN }).violations).toContain("outputTokens");
  });

  test("notice names violations without mutating usage", () => {
    const result = checkUsageInvariant({ totalTokens: 5, inputTokens: 1, outputTokens: 1 });
    expect(formatUsageInvariantNotice(result)).toContain("totalTokens");
    const usage = { inputTokens: 1 };
    checkUsageInvariant(usage);
    expect(usage).toEqual({ inputTokens: 1 });
  });
});

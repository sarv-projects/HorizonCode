import { describe, expect, test } from "bun:test";
import { enrichUsageCost } from "../../src/core/usage-cost";

describe("usage cost (H-2 reduced)", () => {
  test("estimates cache read/write dollars", () => {
    const u = enrichUsageCost(
      { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 500, cacheCreationInputTokens: 200 },
      "anthropic",
      "claude",
    );
    expect(u.cost?.totalUsd).toBeGreaterThan(0);
    expect(u.cost?.cacheReadUsd).toBeGreaterThan(0);
  });
});

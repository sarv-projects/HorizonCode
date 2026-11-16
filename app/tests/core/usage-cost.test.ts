import { describe, expect, test } from "bun:test";
import {
  enrichUsageCost,
  HARNESS_PRICE_TABLE_REVISION,
  usageCostEventFields,
} from "../../src/core/usage-cost";

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

  test("usageCostEventFields emits integer micro-USD harness estimate", () => {
    const fields = usageCostEventFields(
      { inputTokens: 1_000_000, outputTokens: 0 },
      "anthropic",
      "claude",
    );
    expect(fields).toEqual({
      costMicroUsd: 3_000_000, // 1M input @ $3/M
      currency: "USD",
      priceTableRevision: HARNESS_PRICE_TABLE_REVISION,
    });
  });

  test("usageCostEventFields omits when no billable estimate", () => {
    expect(usageCostEventFields({ inputTokens: 0, outputTokens: 0 }, "anthropic", "claude")).toBeUndefined();
  });
});

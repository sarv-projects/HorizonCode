import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_SUB_CALLS_PER_MINUTE,
  ptcLimitTerminationMessage,
  ptcSubCallAllowance,
} from "../../src/tools/codemode-ptc";

describe("PTC sub-call allowance", () => {
  test("2 min default allowance 2048", () => {
    expect(ptcSubCallAllowance(120_000, DEFAULT_MAX_SUB_CALLS_PER_MINUTE)).toBe(2048);
  });

  test("limit message names allowance", () => {
    const msg = ptcLimitTerminationMessage(100, 101);
    expect(msg).toContain("101/100");
    expect(msg).toContain("maxSubCallsPerMinute");
  });
});

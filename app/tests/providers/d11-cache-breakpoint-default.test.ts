/**
 * d11-cache-breakpoint-default.test.ts — D-11: one default, one opt-out.
 *
 * The Anthropic wire stamps breakpoints by default (opt-out =0, ruling 542), but
 * the pure planner defaulted to OFF unless =1. Two different answers for "is it
 * on" is how a stamp silently disappears. The planner now shares the wire's
 * env semantics: unset means ON, =0/=false/=off/=no means OFF.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { planCacheBreakpoints } from "../../src/core/providers/cache-breakpoints";

const previous = process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
afterEach(() => {
  if (previous === undefined) delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
  else process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = previous;
});

const blocks = [
  { kind: "system" as const, text: "stable system" },
  { kind: "stable" as const, text: "stable prefix" },
];

describe("cache breakpoint default", () => {
  test("unset means ON in the planner", () => {
    delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
    expect(planCacheBreakpoints(blocks).length).toBeGreaterThan(0);
  });

  test("=0 is the explicit opt-out", () => {
    process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = "0";
    expect(planCacheBreakpoints(blocks)).toEqual([]);
  });

  test("=1 stays ON", () => {
    process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = "1";
    expect(planCacheBreakpoints(blocks).length).toBeGreaterThan(0);
  });
});

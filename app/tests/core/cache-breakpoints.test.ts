import { describe, expect, test } from "bun:test";
import {
  BREAKPOINT_CAP,
  applyCacheBreakpoints,
  planCacheBreakpoints,
  routeSkipsExplicitCache,
  type CacheableBlock,
} from "../../src/core/providers/cache-breakpoints";

describe("cache-breakpoints planner", () => {
  test("skips openai/gemini routes", () => {
    expect(routeSkipsExplicitCache("openai")).toBe(true);
    expect(routeSkipsExplicitCache("gemini")).toBe(true);
    expect(routeSkipsExplicitCache("anthropic")).toBe(false);
  });

  test("disabled by default", () => {
    const blocks: CacheableBlock[] = [{ kind: "system", text: "s" }];
    expect(planCacheBreakpoints(blocks, { enabled: false })).toEqual([]);
  });

  test("caps at BREAKPOINT_CAP with system+stable+tool tails", () => {
    const blocks: CacheableBlock[] = [
      { kind: "system", text: "sys" },
      { kind: "stable", text: "slab" },
      { kind: "tool_result", text: "t1" },
      { kind: "tool_result", text: "t2" },
      { kind: "tool_result", text: "t3" },
      { kind: "other", text: "x" },
    ];
    const planned = planCacheBreakpoints(blocks, { enabled: true, route: "anthropic" });
    expect(planned.length).toBeLessThanOrEqual(BREAKPOINT_CAP);
    expect(planned[0]?.kind).toBe("system");
    expect(planned[1]?.kind).toBe("stable");
    // Newest tool_result first among remaining slots.
    expect(planned[2]?.index).toBe(4);
    expect(planned[3]?.index).toBe(3);
  });

  test("applyCacheBreakpoints stamps ephemeral markers", () => {
    const blocks = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
    const out = applyCacheBreakpoints(blocks, [
      { index: 0, kind: "system", cache_control: { type: "ephemeral" } },
    ]);
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(out[1]?.cache_control).toBeUndefined();
  });
});

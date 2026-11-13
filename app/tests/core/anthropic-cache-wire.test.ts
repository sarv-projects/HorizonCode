import { describe, expect, test } from "bun:test";
import { applyAnthropicRequestCacheBreakpoints } from "../../src/core/providers/anthropic-cache-wire";

describe("anthropic-cache-wire", () => {
  test("off by default", () => {
    const prev = process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
    delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
    try {
      const messages = [{ role: "user" as const, content: [{ type: "text", text: "hi" }] }];
      expect(applyAnthropicRequestCacheBreakpoints("sys", messages)).toEqual({ system: "sys", messages });
    } finally {
      if (prev === undefined) delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
      else process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = prev;
    }
  });

  test("skips volatile trailing tool_result breakpoints when enabled", () => {
    const prev = process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
    process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = "1";
    try {
      const messages = [
        { role: "user" as const, content: [{ type: "text", text: "u" }] },
        {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: "a", content: "settled" }],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: "b", content: "" }],
        },
      ];
      const out = applyAnthropicRequestCacheBreakpoints("system", messages);
      expect(out.messages[1]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect(out.messages[2]!.content[0]!.cache_control).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
      else process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = prev;
    }
  });

  test("stamps message breakpoints when enabled", () => {
    const prev = process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
    process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = "1";
    try {
      const messages = [
        {
          role: "user" as const,
          content: [{ type: "text", text: "stable slab" }],
        },
        {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }],
        },
      ];
      const out = applyAnthropicRequestCacheBreakpoints("system", messages);
      expect(out.system).toEqual([
        { type: "text", text: "system", cache_control: { type: "ephemeral" } },
      ]);
      expect(out.messages[2]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    } finally {
      if (prev === undefined) delete process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
      else process.env.HZ_ANTHROPIC_CACHE_BREAKPOINTS = prev;
    }
  });
});

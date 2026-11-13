import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  formatCacheablePrefixMeasure,
  measureCacheablePrefix,
} from "../../src/core/providers/anthropic-cache-measure";

describe("anthropic cache measure (ruling 282)", () => {
  test("measureCacheablePrefix counts stable tail boundary", () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "(no output)", toolName: "grep" },
    ];
    const m = measureCacheablePrefix(messages);
    expect(m.totalMessages).toBe(3);
    expect(m.stablePrefixMessages).toBe(2);
    expect(m.cutIndex).toBe(2);
    expect(m.stablePrefixUtf8Bytes).toBeGreaterThan(0);
    expect(formatCacheablePrefixMeasure(m)).toContain("2/3");
    expect(formatCacheablePrefixMeasure(m)).toContain("no API cache-hit");
  });
});

/**
 * capability-descriptor.test.ts -- additive provider capability descriptor
 * (plan Task 4). Provider-level, distinct from model-level catalog capabilities.
 */
import { describe, expect, test } from "bun:test";
import { resolveProviderCapabilities } from "../../src/core/providers/capabilities";

describe("provider capability descriptor", () => {
  test("defaults are permissive for legacy paths, conservative for optional features", () => {
    expect(resolveProviderCapabilities({ provider: "mock" })).toEqual({
      streaming: true,
      tools: true,
      thinking: false,
      usage: false,
      toolCallIds: false,
      partialJson: false,
      steer: false,
    });
  });

  test("declared data overrides defaults; model ids never infer capabilities", () => {
    const merged = resolveProviderCapabilities({
      provider: "openai",
      declared: { steer: true, toolCallIds: true },
    });
    expect(merged.steer).toBe(true);
    expect(merged.toolCallIds).toBe(true);
    expect(merged.streaming).toBe(true);
    expect(resolveProviderCapabilities({ provider: "anything", baseUrl: "https://gpt-6.example" }).steer).toBe(false);
  });

  test("unknown declared keys and undefined values cannot weaken the shape", () => {
    const merged = resolveProviderCapabilities({
      provider: "x",
      declared: { steer: undefined, tools: false } as never,
    });
    expect(merged.steer).toBe(false);
    expect(merged.tools).toBe(false);
    expect(Object.keys(merged).sort()).toEqual([
      "partialJson", "steer", "streaming", "thinking", "toolCallIds", "tools", "usage",
    ]);
  });
});

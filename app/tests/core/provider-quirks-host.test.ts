/**
 * provider-quirks-host.test.ts — host table quirks adapted from opencode's
 * OpenAI-chat capability detection (store, strict tools, tool_stream,
 * parallel_tool_calls guard).
 */
import { describe, expect, test } from "bun:test";
import { applyQuirks } from "../../src/core/providers/quirks";

describe("host-table quirks", () => {
  test("set_store_false only on OpenAI / Azure hosts", () => {
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "u" }] };
    expect(applyQuirks({ provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" }, body)).toContain(
      "set_store_false",
    );
    expect(body.store).toBe(false);
    const other: Record<string, unknown> = { messages: [] };
    expect(applyQuirks({ provider: "custom", model: "m", baseUrl: "https://example.invalid" }, other)).toEqual([]);
    expect(other.store).toBeUndefined();
  });

  test("disable_strict_tools strips function.strict on Moonshot / Together / Nvidia / Cerebras", () => {
    for (const baseUrl of [
      "https://api.moonshot.ai/v1",
      "https://api.together.xyz/v1",
      "https://integrate.api.nvidia.com/v1",
      "https://api.cerebras.ai/v1",
    ]) {
      const body: Record<string, unknown> = {
        messages: [],
        tools: [{ type: "function", function: { name: "t", strict: true, parameters: {} } }],
      };
      const applied = applyQuirks({ provider: "custom", model: "m", baseUrl }, body);
      expect(applied).toContain("disable_strict_tools");
      expect(((body.tools as Array<{ function: Record<string, unknown> }>)[0]!.function).strict).toBeUndefined();
    }
  });

  test("tool_stream set for Zai hosts only when tools are active", () => {
    const withTools: Record<string, unknown> = {
      messages: [],
      tools: [{ type: "function", function: { name: "t" } }],
    };
    expect(applyQuirks({ provider: "custom", model: "glm-4.6", baseUrl: "https://api.z.ai/api" }, withTools)).toContain(
      "tool_stream",
    );
    expect(withTools.tool_stream).toBe(true);
    const noTools: Record<string, unknown> = { messages: [] };
    applyQuirks({ provider: "custom", model: "glm-4.6", baseUrl: "https://api.z.ai/api" }, noTools);
    expect(noTools.tool_stream).toBeUndefined();
  });

  test("guard_parallel_tool_calls drops the field when no tools are present", () => {
    const body: Record<string, unknown> = { messages: [], parallel_tool_calls: true };
    const applied = applyQuirks({ provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" }, body);
    expect(applied).toContain("guard_parallel_tool_calls");
    expect(body.parallel_tool_calls).toBeUndefined();
  });
});

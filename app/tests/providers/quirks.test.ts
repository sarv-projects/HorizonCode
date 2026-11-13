import { describe, expect, test } from "bun:test";
import { applyQuirks } from "../../src/core/providers/quirks";

describe("provider quirks", () => {
  test("deepseek drops response_format", () => {
    const body: Record<string, unknown> = { messages: [], response_format: { type: "json_object" } };
    const applied = applyQuirks({ provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com" }, body);
    expect(applied).toContain("drop_response_format");
    expect(body.response_format).toBeUndefined();
  });

  test("mistral drops parallel_tool_calls", () => {
    const body: Record<string, unknown> = { messages: [], parallel_tool_calls: true };
    const applied = applyQuirks({ provider: "openrouter", model: "mistral-small", baseUrl: "https://openrouter.ai" }, body);
    expect(applied).toContain("drop_parallel_tools_mistral");
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  test("cerebras drops tool_choice", () => {
    const body: Record<string, unknown> = { messages: [], tool_choice: { type: "function", function: { name: "x" } } };
    applyQuirks({ provider: "cerebras", model: "m", baseUrl: "https://api.cerebras.ai" }, body);
    expect(body.tool_choice).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { applyQuirks, previewQuirks } from "../../src/core/providers/quirks";

describe("provider quirks", () => {
  test("nvidia host moves duplicate system after the first message", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "system", content: "a" },
        { role: "user", content: "u" },
        { role: "system", content: "b" },
      ],
    };
    const applied = applyQuirks({ provider: "custom", model: "m", baseUrl: "https://integrate.api.nvidia.com" }, body);
    expect(applied).toContain("ensure_system_first");
    const msgs = body.messages as { role: string }[];
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("system");
    expect(msgs[2].role).toBe("user");
  });

  test("preview matches apply ids for nvidia", () => {
    const ctx = { provider: "custom", model: "m", baseUrl: "https://integrate.api.nvidia.com" };
    expect(previewQuirks(ctx)).toEqual(applyQuirks(ctx, { messages: [{ role: "user", content: "u" }] }));
  });

  test("cerebras host drops reasoning_effort", () => {
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "u" }], reasoning_effort: "high" };
    applyQuirks({ provider: "custom", model: "m", baseUrl: "https://api.cerebras.ai" }, body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("groq host trims long tool call ids", () => {
    const long = "t".repeat(64);
    const body: Record<string, unknown> = {
      messages: [{ role: "assistant", content: "", tool_calls: [{ id: long, type: "function", function: { name: "x", arguments: "{}" } }] }],
    };
    applyQuirks({ provider: "custom", model: "m", baseUrl: "https://api.groq.com" }, body);
    const id = ((body.messages as { tool_calls: { id: string }[] }[])[0].tool_calls[0].id);
    expect(id.length).toBe(40);
  });

  test("unknown host is unchanged", () => {
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "u" }] };
    const before = JSON.stringify(body);
    expect(applyQuirks({ provider: "openai", model: "gpt", baseUrl: "https://api.openai.com" }, body)).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });

  test("o-series renames max_tokens to max_completion_tokens", () => {
    const body: Record<string, unknown> = { max_tokens: 128, messages: [{ role: "user", content: "u" }] };
    const applied = applyQuirks({ provider: "openai", model: "o3-mini", baseUrl: "https://api.openai.com" }, body);
    expect(applied).toContain("o_series_max_completion_tokens");
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(128);
  });

  test("groq strips assistant name", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "assistant", name: "bot", content: "hi" }],
    };
    applyQuirks({ provider: "custom", model: "m", baseUrl: "https://api.groq.com" }, body);
    expect((body.messages as { name?: string }[])[0].name).toBeUndefined();
  });

  test("xAI host drops tool_choice", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "u" }],
      tool_choice: "auto",
    };
    const applied = applyQuirks(
      { provider: "custom", model: "grok-2", baseUrl: "https://api.x.ai/v1" },
      body,
    );
    expect(applied).toContain("drop_tool_choice");
    expect(body.tool_choice).toBeUndefined();
  });

  test("together host appends user after trailing tool message", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [] },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
    };
    const applied = applyQuirks(
      { provider: "custom", model: "m", baseUrl: "https://api.together.xyz" },
      body,
    );
    expect(applied).toContain("force_user_message");
    const msgs = body.messages as { role: string; content?: string }[];
    expect(msgs[msgs.length - 1].role).toBe("user");
    expect(msgs[msgs.length - 1].content).toBe("Continue.");
  });
});

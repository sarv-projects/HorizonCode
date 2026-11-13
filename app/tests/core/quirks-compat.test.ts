import { describe, expect, test } from "bun:test";
import compatTable from "../../src/core/providers/provider-quirks.compat.json";
import { applyQuirks, type CompatEntry } from "../../src/core/providers/quirks";

const entries = (compatTable as { entries: CompatEntry[] }).entries;

describe("provider-quirks.compat.json", () => {
  test("every entry references a known quirk id with a transform", () => {
    const known = new Set([
      "ensure_system_first",
      "trim_parallel_tool_calls",
      "drop_reasoning_effort",
      "trim_tool_call_ids",
      "o_series_max_completion_tokens",
      "drop_response_format",
      "drop_parallel_tools_mistral",
      "strip_assistant_name",
      "drop_tool_choice",
      "force_user_message",
    ]);
    for (const e of entries) {
      expect(known.has(e.quirk)).toBe(true);
      expect(
        (e.hostNeedles?.length ?? 0) + (e.modelNeedles?.length ?? 0) + (e.modelRegex ? 1 : 0),
      ).toBeGreaterThan(0);
    }
  });

  test("new compat host mapping applies without code changes (fireworks)", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "user", content: "go" },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
    };
    const applied = applyQuirks(
      { provider: "custom", model: "m", baseUrl: "https://api.fireworks.ai" },
      body,
    );
    expect(applied).toContain("force_user_message");
    const msgs = body.messages as { role: string }[];
    expect(msgs[msgs.length - 1].role).toBe("user");
  });

  test("unknown host leaves body unchanged", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "u" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    const before = JSON.stringify(body);
    expect(
      applyQuirks({ provider: "acme", model: "gpt-local", baseUrl: "https://example.invalid" }, body),
    ).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });
});

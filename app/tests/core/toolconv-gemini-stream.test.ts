import { describe, expect, test } from "bun:test";
import { drainCompleteGeminiToolCalls } from "../../src/core/providers/toolconv/gemini";

describe("gemini stream scanner", () => {
  const allowed = new Set(["get_current_temperature"]);

  test("drains only closed fences", () => {
    const partial = "```tool_code\nprint(default_api.get_current_temperature(location=";
    const { calls, nextIndex } = drainCompleteGeminiToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete fence", () => {
    const block = '```tool_code\nprint(default_api.get_current_temperature(location="a"))\n```';
    const { calls, nextIndex } = drainCompleteGeminiToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

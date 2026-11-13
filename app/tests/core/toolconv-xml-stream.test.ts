import { describe, expect, test } from "bun:test";
import { drainCompleteForgeXmlToolCalls } from "../../src/core/providers/toolconv/xml";

describe("xml stream scanner", () => {
  const allowed = new Set(["read", "glob"]);

  test("drains only closed blocks", () => {
    const partial = "x<forge_tool_call><tool_name>read";
    const { calls, nextIndex } = drainCompleteForgeXmlToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete block", () => {
    const block = `<forge_tool_call><tool_name>read</tool_name><arguments>{}</arguments></forge_tool_call>`;
    const { calls, nextIndex } = drainCompleteForgeXmlToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
    const tail = drainCompleteForgeXmlToolCalls(`pre ${block} post`, allowed, nextIndex);
    expect(tail.calls).toHaveLength(0);
  });
});

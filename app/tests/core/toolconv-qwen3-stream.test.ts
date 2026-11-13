import { describe, expect, test } from "bun:test";
import { drainCompleteQwen3ToolCalls } from "../../src/core/providers/toolconv/qwen3";

describe("qwen3 stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed Hermes-shaped blocks", () => {
    const partial = '<tool_call>\n{"name": "read"';
    const { calls, nextIndex } = drainCompleteQwen3ToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete block", () => {
    const block = `<tool_call>{"name": "read", "arguments": {}}</tool_call>`;
    const { calls, nextIndex } = drainCompleteQwen3ToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

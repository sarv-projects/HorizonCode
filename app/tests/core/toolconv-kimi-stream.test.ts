import { describe, expect, test } from "bun:test";
import { drainCompleteKimiToolCalls } from "../../src/core/providers/toolconv/kimi";

describe("kimi stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed sections", () => {
    const partial =
      `<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":`;
    const { calls, nextIndex } = drainCompleteKimiToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete section", () => {
    const block =
      `<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a"}<|tool_call_end|>`;
    const { calls, nextIndex } = drainCompleteKimiToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
    const tail = drainCompleteKimiToolCalls(`pre ${block} post`, allowed, nextIndex);
    expect(tail.calls).toHaveLength(0);
  });
});

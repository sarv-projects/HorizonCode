import { describe, expect, test } from "bun:test";
import { drainCompleteHermesToolCalls } from "../../src/core/providers/toolconv/hermes";

describe("hermes stream scanner", () => {
  const allowed = new Set(["read", "glob"]);

  test("drains only closed blocks", () => {
    const partial = 'x<tool_call>\n{"name": "read"';
    const { calls, nextIndex } = drainCompleteHermesToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete block", () => {
    const block = `<tool_call>{"name": "read", "arguments": {}}</tool_call>`;
    const { calls, nextIndex } = drainCompleteHermesToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
    const tail = drainCompleteHermesToolCalls(`pre ${block} post`, allowed, nextIndex);
    expect(tail.calls).toHaveLength(0);
  });
});

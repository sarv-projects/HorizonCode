import { describe, expect, test } from "bun:test";
import { drainCompleteHarmonyToolCalls } from "../../src/core/providers/toolconv/harmony";

describe("harmony stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed messages", () => {
    const partial = `<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":`;
    const { calls, nextIndex } = drainCompleteHarmonyToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete message", () => {
    const block = `<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"a"}<|call|>`;
    const { calls, nextIndex } = drainCompleteHarmonyToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
    const tail = drainCompleteHarmonyToolCalls(`pre ${block} post`, allowed, nextIndex);
    expect(tail.calls).toHaveLength(0);
  });
});

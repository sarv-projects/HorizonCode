import { describe, expect, test } from "bun:test";
import { drainCompleteMinimaxInvokeCalls } from "../../src/core/providers/toolconv/minimax";

describe("minimax stream scanner", () => {
  const allowed = new Set(["read", "glob"]);

  test("drains only closed invoke blocks", () => {
    const partial = '<invoke name="read"><parameter name="path">a';
    const { calls, nextIndex } = drainCompleteMinimaxInvokeCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete invoke", () => {
    const block = '<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const { calls, nextIndex } = drainCompleteMinimaxInvokeCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
    const tail = drainCompleteMinimaxInvokeCalls(`pre ${block} post`, allowed, nextIndex);
    expect(tail.calls).toHaveLength(0);
  });
});

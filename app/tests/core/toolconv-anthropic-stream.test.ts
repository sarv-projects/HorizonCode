import { describe, expect, test } from "bun:test";
import { drainCompleteAnthropicInvokeCalls } from "../../src/core/providers/toolconv/anthropic";

describe("anthropic stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed invoke blocks", () => {
    const partial = '<invoke name="read"><parameter name="path">a';
    const { calls, nextIndex } = drainCompleteAnthropicInvokeCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete invoke", () => {
    const block = '<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const { calls, nextIndex } = drainCompleteAnthropicInvokeCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

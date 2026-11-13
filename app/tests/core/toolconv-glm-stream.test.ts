import { describe, expect, test } from "bun:test";
import { drainCompleteGlmToolCalls } from "../../src/core/providers/toolconv/glm";

describe("glm stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed blocks", () => {
    const partial = "<tool_call>read\n<arg_key>path</arg_key><arg_value>";
    const { calls, nextIndex } = drainCompleteGlmToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete block", () => {
    const block =
      "<tool_call>read\n<arg_key>path</arg_key><arg_value>a.txt</arg_value>\n</tool_call>";
    const { calls, nextIndex } = drainCompleteGlmToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

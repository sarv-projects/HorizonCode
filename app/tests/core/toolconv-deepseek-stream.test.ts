import { describe, expect, test } from "bun:test";
import {
  DS_TOOL_CALL_BEGIN,
  DS_TOOL_CALL_END,
  DS_TOOL_SEP,
  drainCompleteDeepseekToolCalls,
} from "../../src/core/providers/toolconv/deepseek";

describe("deepseek stream scanner", () => {
  const allowed = new Set(["read"]);

  test("drains only closed marker sequences", () => {
    const partial = `${DS_TOOL_CALL_BEGIN}read${DS_TOOL_SEP}{"path":`;
    const { calls, nextIndex } = drainCompleteDeepseekToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete call", () => {
    const block = `${DS_TOOL_CALL_BEGIN}read${DS_TOOL_SEP}{"path":"a"}${DS_TOOL_CALL_END}`;
    const { calls, nextIndex } = drainCompleteDeepseekToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

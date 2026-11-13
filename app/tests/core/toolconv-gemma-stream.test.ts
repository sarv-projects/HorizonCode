import { describe, expect, test } from "bun:test";
import {
  drainCompleteGemmaToolCalls,
  GEMMA_CALL_CLOSE,
  GEMMA_CALL_OPEN,
  GEMMA_STR,
} from "../../src/core/providers/toolconv/gemma";

describe("gemma stream scanner", () => {
  const allowed = new Set(["get_current_temperature"]);

  test("drains only closed token blocks", () => {
    const partial = `${GEMMA_CALL_OPEN}call:get_current_temperature{location:`;
    const { calls, nextIndex } = drainCompleteGemmaToolCalls(partial, allowed, 0);
    expect(calls).toHaveLength(0);
    expect(nextIndex).toBe(0);
  });

  test("increments nextIndex past complete block", () => {
    const block =
      `${GEMMA_CALL_OPEN}call:get_current_temperature{location:${GEMMA_STR}London${GEMMA_STR}}${GEMMA_CALL_CLOSE}`;
    const { calls, nextIndex } = drainCompleteGemmaToolCalls(`pre ${block} post`, allowed, 0);
    expect(calls).toHaveLength(1);
    expect(nextIndex).toBe(`pre ${block}`.length);
  });
});

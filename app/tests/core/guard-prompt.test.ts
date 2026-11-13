import { describe, expect, test } from "bun:test";
import {
  consecutiveMistakesInterruptNudge,
  loopDetectionInterruptNudge,
  wrapSystemInterrupt,
} from "../../src/core/guards/guard-prompt";

describe("guard prompts", () => {
  test("wrapSystemInterrupt", () => {
    expect(wrapSystemInterrupt("x", "body")).toBe('<system-interrupt reason="x">\nbody\n</system-interrupt>');
  });

  test("loopDetectionInterruptNudge substitutes tool and count", () => {
    const text = loopDetectionInterruptNudge("read", 4);
    expect(text).toContain('reason="tool_call_loop"');
    expect(text).toContain("`read`");
    expect(text).toContain("4");
  });

  test("consecutiveMistakesInterruptNudge", () => {
    const text = consecutiveMistakesInterruptNudge(2, 3);
    expect(text).toContain('reason="consecutive_mistakes"');
    expect(text).toContain("2");
    expect(text).toContain("3");
  });
});

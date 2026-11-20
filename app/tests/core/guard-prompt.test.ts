import { describe, expect, test } from "bun:test";
import {
  actionStationarityInterruptNudge,
  budgetExhaustionInterruptNudge,
  consecutiveMistakesInterruptNudge,
  contextOverflowInterruptNudge,
  emptyResponseInterruptNudge,
  formatErrorsInterruptNudge,
  loadGuardPrompt,
  loopDetectionInterruptNudge,
  repeatedToolErrorInterruptNudge,
  thinkingLoopInterruptNudge,
  wrapSystemInterrupt,
  type GuardPromptId,
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

  test("actionStationarityInterruptNudge", () => {
    const text = actionStationarityInterruptNudge("read", 3);
    expect(text).toContain('reason="action_stationarity"');
    expect(text).toContain("true-noop");
  });

  test("formatErrorsInterruptNudge", () => {
    const text = formatErrorsInterruptNudge(1, 3);
    expect(text).toContain('reason="format_errors"');
    expect(text).toContain("1/3");
    expect(text).toContain("invalid JSON");
  });

  test("contextOverflowInterruptNudge", () => {
    const text = contextOverflowInterruptNudge();
    expect(text).toContain('reason="context_overflow"');
    expect(text).toContain("emergency compaction");
    expect(text).toContain("<system-interrupt");
    expect(text).toContain("</system-interrupt>");
  });

  test("repeatedToolErrorInterruptNudge selects the class and wraps it", () => {
    const text = repeatedToolErrorInterruptNudge(2, 3);
    expect(text).toContain('reason="repeated_tool_error"');
    expect(text).toContain("<system-interrupt");
    expect(text).toContain("</system-interrupt>");
    expect(text).toContain("2");
    expect(text).toContain("3");
    expect(text).toContain("Repeating the same failing call");
  });

  test("budgetExhaustionInterruptNudge selects the class and wraps it", () => {
    const text = budgetExhaustionInterruptNudge("2 steps");
    expect(text).toContain('reason="budget_exhaustion"');
    expect(text).toContain("<system-interrupt");
    expect(text).toContain("</system-interrupt>");
    expect(text).toContain("2 steps");
    expect(text).toContain("Wrap up");
  });

  test("thinkingLoopInterruptNudge wraps thinking-loop.md (ruling 566)", () => {
    const text = thinkingLoopInterruptNudge();
    expect(text).toContain('reason="thinking_loop"');
    expect(text).toContain("<system-interrupt");
    expect(text).toContain("</system-interrupt>");
  });

  test("emptyResponseInterruptNudge wraps empty-response.md (ruling 566)", () => {
    const text = emptyResponseInterruptNudge(2, 3);
    expect(text).toContain('reason="empty_response"');
    expect(text).toContain("2");
    expect(text).toContain("3");
  });

  test("all nine C-10 guard prompt files load non-empty (ruling 566)", () => {
    const ids: GuardPromptId[] = [
      "tool-call-loop",
      "action-stationarity",
      "consecutive-mistakes",
      "format-errors",
      "context-overflow",
      "thinking-loop",
      "repeated-tool-error",
      "budget-exhaustion",
      "empty-response",
    ];
    for (const id of ids) {
      expect(loadGuardPrompt(id).trim().length).toBeGreaterThan(0);
    }
  });
});

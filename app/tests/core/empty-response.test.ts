import { describe, expect, test } from "bun:test";
import {
  checkEmptyResponse,
  createEmptyResponseState,
  EmptyResponseTracker,
  isEmptyResponse,
  MAX_EMPTY_RESPONSES,
  NUDGE_AFTER_EMPTY_RESPONSES,
} from "../../src/core/guards/empty-response";
import { emptyResponseInterruptNudge, loadGuardPrompt } from "../../src/core/guards/guard-prompt";

describe("empty-response guard (C-10 residual)", () => {
  test("isEmptiness is strict: tools/text/thinking reset the signal", () => {
    expect(isEmptyResponse({ toolCallCount: 0, thinkingText: "", assistantText: "" })).toBe(true);
    expect(isEmptyResponse({ toolCallCount: 1, thinkingText: "", assistantText: "" })).toBe(false);
    expect(isEmptyResponse({ toolCallCount: 0, thinkingText: "  ", assistantText: "" })).toBe(true);
    expect(isEmptyResponse({ toolCallCount: 0, thinkingText: "", assistantText: "final" })).toBe(false);
  });

  test("soft nudge from the first empty; bounded hard stop", () => {
    const state = createEmptyResponseState();
    expect(NUDGE_AFTER_EMPTY_RESPONSES).toBe(1);
    const first = checkEmptyResponse(state, { toolCallCount: 0, thinkingText: "", assistantText: "" });
    expect(first.kind).toBe("soft");
    const second = checkEmptyResponse(state, { toolCallCount: 0, thinkingText: "", assistantText: "" });
    expect(second.kind).toBe("soft");
    const third = checkEmptyResponse(state, { toolCallCount: 0, thinkingText: "", assistantText: "" });
    expect(third.kind).toBe("hard");
    expect(third.count).toBe(MAX_EMPTY_RESPONSES);
    expect(third.message).toContain("empty");
  });

  test("a real step or reset clears the streak", () => {
    const tracker = new EmptyResponseTracker();
    expect(tracker.inspect({ toolCallCount: 0, thinkingText: "", assistantText: "" }).kind).toBe("soft");
    expect(tracker.inspect({ toolCallCount: 1, thinkingText: "", assistantText: "" }).kind).toBe("ok");
    tracker.inspect({ toolCallCount: 0, thinkingText: "", assistantText: "" });
    tracker.reset();
    expect(tracker.inspect({ toolCallCount: 0, thinkingText: "", assistantText: "" }).kind).toBe("soft");
  });

  test("the nudge uses the same <system-interrupt reason> wrapper", () => {
    const text = emptyResponseInterruptNudge(2, MAX_EMPTY_RESPONSES);
    expect(text).toContain('<system-interrupt reason="empty_response">');
    expect(text).toContain("</system-interrupt>");
    expect(text).toContain("empty response");
    expect(loadGuardPrompt("empty-response")).toContain("Act or answer");
  });
});

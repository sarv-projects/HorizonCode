/**
 * mistake-tracker.test.ts — SAFETY-RAILS rail 2 (consecutive-mistake taxonomy).
 *
 * Increments across the three reasons, continues below the max, stops at the
 * max with the exact state-preserved message tail, and resets. Every assertion
 * fails if the rail is reverted.
 */

import { describe, expect, test } from "bun:test";
import {
  buildMistakeLimitStopMessage,
  DEFAULT_MAX_CONSECUTIVE_MISTAKES,
  MistakeTracker,
} from "../../../src/core/guards/mistake-tracker";

const RESUMABLE_TAIL = "Session state was preserved. Send a new prompt to resume from the latest state.";

describe("MistakeTracker", () => {
  test("increments across the three reasons and stops at the default max", () => {
    const tracker = new MistakeTracker();
    expect(DEFAULT_MAX_CONSECUTIVE_MISTAKES).toBe(3);
    expect(tracker.record({ reason: "api_error" }).action).toBe("continue");
    expect(tracker.record({ reason: "invalid_tool_call" }).action).toBe("continue");
    const third = tracker.record({ reason: "tool_execution_failed" });
    expect(third.action).toBe("stop");
    expect(tracker.value).toBe(3);
  });

  test("the stop message ends verbatim with the resumable tail and names the streak", () => {
    const tracker = new MistakeTracker({ maxConsecutiveMistakes: 2 });
    tracker.record({ reason: "api_error", details: "boom" });
    const outcome = tracker.record({ reason: "api_error", details: "boom again" });
    expect(outcome.action).toBe("stop");
    if (outcome.action !== "stop") throw new Error("expected stop");
    expect(outcome.message.endsWith(RESUMABLE_TAIL)).toBe(true);
    expect(outcome.message).toContain("2/2 consecutive mistakes (api_error)");
    expect(outcome.message).toContain("Error: boom again");
  });

  test("reset() clears the streak so the limit is not hit prematurely", () => {
    const tracker = new MistakeTracker({ maxConsecutiveMistakes: 2 });
    tracker.record({ reason: "api_error" });
    tracker.reset();
    expect(tracker.value).toBe(0);
    expect(tracker.record({ reason: "api_error" }).action).toBe("continue");
  });

  test("buildMistakeLimitStopMessage always ends with the resumable tail", () => {
    const msg = buildMistakeLimitStopMessage({
      consecutiveMistakes: 3,
      maxConsecutiveMistakes: 3,
      reason: "tool_execution_failed",
    });
    expect(msg.endsWith(RESUMABLE_TAIL)).toBe(true);
    expect(msg).toContain("3/3 consecutive mistakes (tool_execution_failed)");
  });
});

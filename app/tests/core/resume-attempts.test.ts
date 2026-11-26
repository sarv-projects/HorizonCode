/**
 * resume-attempts.test.ts -- bounded resume counter (plan Task 19).
 * Pure helper; default transcript-resume path is unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
  canResume,
  MAX_RESUME_ATTEMPTS,
  nextResumeAttempt,
  ResumeAttemptsExceeded,
  type ResumeAttemptState,
} from "../../src/core/resume-attempts";

describe("bounded resume attempts", () => {
  test("attempts are bounded per session and refuse past the cap", () => {
    let state: ResumeAttemptState = { sessionId: "s1", attempts: 0 };
    while (canResume(state)) state = nextResumeAttempt(state);
    expect(state.attempts).toBe(MAX_RESUME_ATTEMPTS);
    expect(() => nextResumeAttempt(state)).toThrow(ResumeAttemptsExceeded);
    expect(canResume({ sessionId: "other", attempts: 0 })).toBe(true);
  });

  test("a different session id is refused and invalid counters fail closed", () => {
    expect(() => nextResumeAttempt({ sessionId: "a", attempts: 1 }, "b")).toThrow(/session/i);
    expect(canResume({ sessionId: "a", attempts: -1 })).toBe(false);
    expect(() => nextResumeAttempt({ sessionId: "a", attempts: Number.NaN })).toThrow(/attempt/i);
  });
});

/**
 * resume-attempts.ts -- bounded resume counter (plan Task 19).
 * Pure helper only; persistence across host restart remains OPEN.
 */

export const MAX_RESUME_ATTEMPTS = 3;

export class ResumeAttemptsExceeded extends Error {
  constructor(sessionId: string) {
    super(`resume attempts exhausted for session ${sessionId}`);
    this.name = "ResumeAttemptsExceeded";
  }
}

export interface ResumeAttemptState {
  sessionId: string;
  attempts: number;
}

export function canResume(state: ResumeAttemptState): boolean {
  return Number.isInteger(state.attempts) && state.attempts >= 0 && state.attempts < MAX_RESUME_ATTEMPTS;
}

/** Increment at most to the cap; a caller-supplied session id must match. */
export function nextResumeAttempt(
  state: ResumeAttemptState,
  expectedSessionId?: string,
): ResumeAttemptState {
  if (expectedSessionId !== undefined && expectedSessionId !== state.sessionId) {
    throw new Error("HZ_PRECONDITION_FAILED: resume attempt belongs to a different session");
  }
  if (!Number.isInteger(state.attempts) || state.attempts < 0) {
    throw new Error("HZ_PRECONDITION_FAILED: resume attempts must be a non-negative integer");
  }
  if (state.attempts >= MAX_RESUME_ATTEMPTS) throw new ResumeAttemptsExceeded(state.sessionId);
  return { sessionId: state.sessionId, attempts: state.attempts + 1 };
}

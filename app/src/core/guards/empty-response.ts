/**
 * empty-response.ts — C-10 residual: an empty provider response (no text, no
 * thinking, no tool call) makes no progress. Soft → `<system-interrupt
 * reason="empty_response">` nudge via guard-prompt; hard → loop stops with
 * detail `empty_response` after a bounded number of consecutive empties.
 *
 * Pure detector + small stateful tracker, mirroring thinking-loop.ts. A tool
 * call, or any non-empty text/thinking, resets the streak. Disable with
 * `HZ_EMPTY_RESPONSE=0`.
 */

/** First empty response already gets a nudge (it is never legitimate progress). */
export const NUDGE_AFTER_EMPTY_RESPONSES = 1;
/** Hard stop after this many consecutive empty responses. */
export const MAX_EMPTY_RESPONSES = 3;

export interface EmptyResponseStep {
  toolCallCount: number;
  thinkingText: string;
  assistantText: string;
}

export interface EmptyResponseVerdict {
  kind: "ok" | "soft" | "hard";
  count: number;
  message?: string;
}

export interface EmptyResponseState {
  consecutive: number;
}

export function createEmptyResponseState(): EmptyResponseState {
  return { consecutive: 0 };
}

export function resetEmptyResponseState(state: EmptyResponseState): void {
  state.consecutive = 0;
}

/** True when a step emitted nothing usable (no tools, no text, no thinking). */
export function isEmptyResponse(step: EmptyResponseStep): boolean {
  if (step.toolCallCount > 0) return false;
  return step.thinkingText.trim() === "" && step.assistantText.trim() === "";
}

/** Advance the streak for one completed provider step. */
export function checkEmptyResponse(
  state: EmptyResponseState,
  step: EmptyResponseStep,
): EmptyResponseVerdict {
  if (!isEmptyResponse(step)) {
    resetEmptyResponseState(state);
    return { kind: "ok", count: 0 };
  }
  state.consecutive += 1;
  const count = state.consecutive;
  if (count >= MAX_EMPTY_RESPONSES) {
    return {
      kind: "hard",
      count,
      message: `Detected ${count} consecutive empty responses; stopping to avoid a no-progress stall.`,
    };
  }
  if (count >= NUDGE_AFTER_EMPTY_RESPONSES) {
    return {
      kind: "soft",
      count,
      message: `Empty response (${count}/${MAX_EMPTY_RESPONSES}); nudging the model to act or answer.`,
    };
  }
  return { kind: "ok", count };
}

export class EmptyResponseTracker {
  private readonly state = createEmptyResponseState();

  inspect(step: EmptyResponseStep): EmptyResponseVerdict {
    return checkEmptyResponse(this.state, step);
  }

  reset(): void {
    resetEmptyResponseState(this.state);
  }
}

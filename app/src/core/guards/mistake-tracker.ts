/**
 * mistake-tracker.ts — consecutive-mistake taxonomy (NF-safety rail 2).
 *
 * A self-contained port of cline's mistake-tracker safety rail
 * (packages/core/src/runtime/safety/mistake-tracker.ts), reduced to the
 * HorizonCode loop's needs (no @cline/shared imports, no event/log/telemetry
 * callbacks). It counts consecutive mistakes across three reasons and, at the
 * limit, returns a stop decision carrying a resumable message. The loop owns
 * the instance; nothing here imports the loop.
 *
 * This is a NEW, SEPARATE axis from the NF-073 format-error cap
 * (MAX_CONSECUTIVE_FORMAT_ERRORS in loop.ts): the format cap counts whole
 * batches of invalid-JSON tool arguments and exits with detail `format_errors`,
 * while this tracker counts provider errors, invalid tool calls and tool
 * execution failures and exits with detail `consecutive_mistakes`. The two
 * rails fire independently and are never folded together.
 */

/** The three mistake kinds the tracker distinguishes. */
export type MistakeReason = "api_error" | "invalid_tool_call" | "tool_execution_failed";

/**
 * The default consecutive-mistake limit. Named distinctly from
 * `MAX_CONSECUTIVE_FORMAT_ERRORS` (loop.ts) so the two rails stay obviously
 * separate. Three matches the format cap's tolerance without being coupled to
 * it: a run that makes three mistakes in a row of the SAME broad class (any mix
 * of the three reasons) is not making progress and stops with state preserved.
 */
export const DEFAULT_MAX_CONSECUTIVE_MISTAKES = 3;

/** One recorded mistake: its reason and optional human-readable details. */
export interface RecordMistakeInput {
  reason: MistakeReason;
  details?: string;
}

/** The decision a `record` returns: keep going, or stop with a resumable message. */
export type MistakeOutcome = { action: "continue" } | { action: "stop"; message: string };

/**
 * Build the verbatim stop message. It names the streak, the limit and the
 * reason, folds in any details, and ALWAYS ends with the resumable tail so a
 * caller (and the model) knows state was kept and a fresh prompt resumes.
 */
export function buildMistakeLimitStopMessage(input: {
  consecutiveMistakes: number;
  maxConsecutiveMistakes: number;
  reason: MistakeReason;
  details?: string;
}): string {
  const parts = [
    `Stopped after ${input.consecutiveMistakes}/${input.maxConsecutiveMistakes} consecutive mistakes (${input.reason}).`,
  ];
  const details = input.details?.trim();
  if (details) {
    parts.push(`Error: ${details}`);
  }
  parts.push("Session state was preserved. Send a new prompt to resume from the latest state.");
  return parts.join(" ");
}

/**
 * Per-run consecutive-mistake counter. The loop constructs one instance per run
 * and calls `record()` on a provider error (`api_error`), a pure-format-error
 * batch (`invalid_tool_call`, in addition to the independent format cap) and a
 * tool that returned `ok:false` (`tool_execution_failed`). A clean, successful
 * tool step calls `reset()`.
 */
export class MistakeTracker {
  private consecutiveMistakes = 0;
  private readonly maxConsecutiveMistakes: number;

  constructor(options?: { maxConsecutiveMistakes?: number }) {
    const max = options?.maxConsecutiveMistakes ?? DEFAULT_MAX_CONSECUTIVE_MISTAKES;
    this.maxConsecutiveMistakes = max;
  }

  record(input: RecordMistakeInput): MistakeOutcome {
    const max = this.maxConsecutiveMistakes;
    this.consecutiveMistakes += 1;
    const next = this.consecutiveMistakes;

    if (!max || next < max) {
      return { action: "continue" };
    }
    return {
      action: "stop",
      message: buildMistakeLimitStopMessage({
        consecutiveMistakes: next,
        maxConsecutiveMistakes: max,
        reason: input.reason,
        details: input.details,
      }),
    };
  }

  reset(): void {
    this.consecutiveMistakes = 0;
  }

  /**
   * Consecutive mistakes still allowed before the stop (limit minus streak,
   * never below 0); Infinity when the limit is disabled.
   */
  get remaining(): number {
    const max = this.maxConsecutiveMistakes;
    return !max ? Number.POSITIVE_INFINITY : Math.max(0, max - this.consecutiveMistakes);
  }

  /** The current consecutive-mistake count (for tests and diagnostics). */
  get value(): number {
    return this.consecutiveMistakes;
  }
}

/**
 * The line appended to a failed tool result so the model sees its budget
 * (forgecode renders the same on every failed result). `remaining` is the
 * number of further failed steps allowed once the one being reported is
 * counted; 0 means this failure reached the limit and the run stops. Returns
 * "" for a disabled (infinite) limit, so no misleading number is shown.
 */
export function attemptsRemainingNote(remaining: number): string {
  if (!Number.isFinite(remaining)) return "";
  const n = Math.max(0, Math.floor(remaining));
  return `\n[attempts remaining before this run stops: ${n}]`;
}

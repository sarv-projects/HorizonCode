/**
 * clock-in-out.ts — Group A clock-in/out initializer-first phase
 * (learn-harness-engineering ADAPT).
 *
 * A pure deterministic checklist tracker for the fixed 6-step startup
 * (clock-in) and 5-step clean-state exit (clock-out). Tracks which steps were
 * performed IN ORDER; a step is only recorded when it is the next expected one.
 * No I/O, no authority — the caller performs the actual step and reports it.
 */

export const CLOCK_IN_STEPS = [
  "pwd", "progress", "featureList", "gitLog", "initScript", "baselineSmoke",
] as const;

export const CLOCK_OUT_STEPS = [
  "cleanupScan", "verifyClean", "finalVerify", "recordSummary", "release",
] as const;

export type ClockStep = string;
export type ClockPhase = "in" | "out";

export interface ClockState {
  phase: ClockPhase;
  done: ClockStep[];
}

export interface ClockReport {
  phase: ClockPhase;
  complete: boolean;
  remaining: ClockStep[];
}

function stepsFor(phase: ClockPhase): readonly ClockStep[] {
  return phase === "in" ? CLOCK_IN_STEPS : CLOCK_OUT_STEPS;
}

export function createClockState(phase: ClockPhase): ClockState {
  return { phase, done: [] };
}

/** Record `step` only when it is the next expected step; otherwise no-op. */
export function stepClock(state: ClockState, step: ClockStep): ClockState {
  const steps = stepsFor(state.phase);
  const expected = steps[state.done.length];
  if (expected === undefined || step !== expected) return state;
  return { phase: state.phase, done: [...state.done, step] };
}

export function clockReport(state: ClockState): ClockReport {
  const steps = stepsFor(state.phase);
  const remaining = steps.slice(state.done.length);
  return { phase: state.phase, complete: remaining.length === 0, remaining: [...remaining] };
}

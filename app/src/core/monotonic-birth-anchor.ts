/**
 * monotonic-birth-anchor.ts -- D-3 sleep/wake re-anchor decision helper.
 *
 * Pure: every clock reading and process fact is injected; no OS access, no
 * timers, no wiring. A VM suspend/resume can move the wall clock (NTP step or
 * wake) and, on some hypervisors, the monotonic tick baseline, without issuing
 * a new boot id. That must NOT make a live process look dead (nor a recycled
 * pid look alive). This helper decides, fail-closed:
 *
 *   - boot id changed            -> refuse (new boot: pid may be reused)
 *   - process startTicks changed -> refuse (pid was reused)
 *   - clocks agree within tol    -> same-birth (no re-anchor needed)
 *   - clocks diverged, identity  -> re-anchored (safe to adopt a new baseline)
 *     still stable
 *
 * It is an unwired surface: adopting the verdict into `verifyIdentity` is a
 * later slice and must preserve the existing fail-closed pid-reuse refusal.
 */

export type MonotonicAnchorVerdict = "same-birth" | "re-anchored" | "refuse";

export interface BirthAnchorState {
  bootId: string;
  /** Process start time in clock ticks since boot (the birth marker). */
  startTicks: number;
  /** Monotonic clock reading when the birth was recorded (nanoseconds). */
  monotonicNs: bigint;
  /** Wall clock reading when the birth was recorded (milliseconds). */
  wallAtRecordMs: number;
}

export interface BirthReconcileInput {
  recorded: BirthAnchorState;
  observedBootId: string;
  /** Freshly re-read from the OS (e.g. /proc/<pid>/stat starttime). */
  observedStartTicks: number;
  observedMonotonicNs: bigint;
  observedWallMs: number;
  /** Max tolerated wall-vs-monotonic drift (ms) before a re-anchor is required. */
  skewToleranceMs?: number;
}

export const DEFAULT_SKEW_TOLERANCE_MS = 2000;

function validTick(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function reconcileBirthAnchor(input: BirthReconcileInput): MonotonicAnchorVerdict {
  const tolerance = input.skewToleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS;
  if (!Number.isFinite(tolerance) || tolerance < 0) return "refuse";
  if (
    typeof input.recorded?.bootId !== "string" ||
    input.recorded.bootId.trim() === "" ||
    typeof input.observedBootId !== "string" ||
    input.observedBootId.trim() === ""
  ) {
    return "refuse";
  }
  if (
    !validTick(input.recorded.startTicks) ||
    !validTick(input.observedStartTicks) ||
    typeof input.recorded.monotonicNs !== "bigint" ||
    typeof input.observedMonotonicNs !== "bigint" ||
    input.recorded.monotonicNs < 0n ||
    input.observedMonotonicNs < 0n ||
    !Number.isFinite(input.recorded.wallAtRecordMs) ||
    !Number.isFinite(input.observedWallMs)
  ) {
    return "refuse";
  }

  // Identity first: a new boot or a recycled pid can never be re-anchored.
  if (input.observedBootId !== input.recorded.bootId) return "refuse";
  if (input.observedStartTicks !== input.recorded.startTicks) return "refuse";

  // A monotonic clock that moves backwards is an untrustworthy reading.
  if (input.observedMonotonicNs < input.recorded.monotonicNs) return "refuse";

  const monotonicDeltaMs = Number(input.observedMonotonicNs - input.recorded.monotonicNs) / 1e6;
  const wallDeltaMs = input.observedWallMs - input.recorded.wallAtRecordMs;
  const skewMs = Math.abs(wallDeltaMs - monotonicDeltaMs);
  return skewMs <= tolerance ? "same-birth" : "re-anchored";
}

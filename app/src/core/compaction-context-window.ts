/**
 * Emergency history shrink when the provider returns CONTEXT_WINDOW_EXCEEDED.
 * Route-on-code (docs/30 §8 #12); one forced compaction pass per run before fail.
 */

import type { ProviderFailureCode } from "../contracts";

/** Four-step emergency shrink ladder (plan Task 10); step is clamped to the last rung. */
export const EMERGENCY_SHRINK_LADDER = [0.85, 0.7, 0.5, 0.35] as const;

/** Image-budget hysteresis band (Tier 1 #11 / opencode compaction). */
export const IMAGE_BUDGET_LOW_WATER = 0.5;
export const IMAGE_BUDGET_HIGH_WATER = 0.7;

/**
 * Next image-budget rung given current pressure (0..1 headroom) and the current
 * rung. Shrinks only below the low-water mark; recovers only above the high-water
 * mark, so a value oscillating near a threshold cannot flap between rungs.
 */
export function nextImageRung(headroom: number, currentRung: number): number {
  if (!Number.isFinite(headroom)) return currentRung;
  const rung = Math.max(0, Math.floor(currentRung));
  if (headroom < IMAGE_BUDGET_LOW_WATER) return rung + 1;
  if (headroom > IMAGE_BUDGET_HIGH_WATER) return Math.max(0, rung - 1);
  return rung;
}

export function isContextWindowExceededCode(code: ProviderFailureCode | undefined): boolean {
  return code === "CONTEXT_WINDOW_EXCEEDED";
}

/**
 * Next provider-view message cap after a context-window failure, or null when
 * history is already minimal (caller should fail the turn).
 */
export function emergencyHistoryLimit(
  currentLimit: number,
  messageCount: number,
  shrinkStep = 0,
): number | null {
  const cur = Math.max(1, Math.floor(currentLimit));
  const n = Math.max(0, Math.floor(messageCount));
  if (n <= 1) return null;
  const index = Math.min(
    EMERGENCY_SHRINK_LADDER.length - 1,
    Math.max(0, Math.floor(shrinkStep)),
  );
  const factor = EMERGENCY_SHRINK_LADDER[index] ?? EMERGENCY_SHRINK_LADDER[0];
  const shrunk = Math.max(1, Math.floor(cur * factor));
  const next = Math.min(n - 1, shrunk);
  return next >= 1 && next < n ? next : null;
}

export const CONTEXT_WINDOW_COMPACTION_NOTICE =
  "provider context window exceeded — forcing one emergency compaction before ending the turn";

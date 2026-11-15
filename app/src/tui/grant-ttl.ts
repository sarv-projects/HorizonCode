/**
 * Session grant TTL copy (Wave C §8 #6; `SESSION_LEASE_TTL_MS` in loop.ts).
 */

import { SESSION_LEASE_TTL_MS } from "../core/loop";

/** Whole-minute TTL shown in approval copy (minimum 1). */
export function sessionGrantTtlMinutes(ttlMs: number = SESSION_LEASE_TTL_MS): number {
  return Math.max(1, Math.round(ttlMs / 60_000));
}

export function formatSessionGrantExpiry(ttlMs: number = SESSION_LEASE_TTL_MS): string {
  const minutes = sessionGrantTtlMinutes(ttlMs);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Ceil remaining ms to whole minutes for approval copy (minimum 1). */
export function grantRemainingMinutesFromMs(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

/** Live countdown copy for an active session grant (sub-minute when under 5 minutes). */
export function formatGrantRemainingForApproval(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const totalSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0 && min > 0) return min === 1 ? "~1 minute" : `~${min} minutes`;
  if (min >= 5) return min === 1 ? "~1 minute" : `~${min} minutes`;
  if (min > 0) return `~${min}m ${sec}s`;
  return `~${sec}s`;
}
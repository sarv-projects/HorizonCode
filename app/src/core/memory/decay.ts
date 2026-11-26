/**
 * decay.ts -- store-day recency decay (plan Task 22). Pure ranking helper.
 * No clock read inside; `storedAtMs` and `nowMs` are injected. Not a guard.
 */

export const MEMORY_RECALL_HALF_LIFE_DAYS = 30;

const DAY_MS = 86_400_000;

export function storeDayDecay(
  score: number,
  storedAtMs: number,
  nowMs: number,
  halfLifeDays = MEMORY_RECALL_HALF_LIFE_DAYS,
): number {
  if (!Number.isFinite(score) || score < 0) return 0;
  if (!Number.isFinite(storedAtMs) || !Number.isFinite(nowMs)) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  const ageDays = Math.max(0, (nowMs - storedAtMs) / DAY_MS);
  return score * 0.5 ** (ageDays / halfLifeDays);
}

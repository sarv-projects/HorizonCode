/**
 * thinking-budget.ts — bounded thinking-token cap (course/clawspring ADAPT).
 *
 * Pure per-turn accumulator: each `add(text)` estimates tokens (bytes/4, the
 * repo-wide convention) and admits up to a cap. The first delta that crosses
 * the cap is clamped to the remaining budget and flagged; further deltas are
 * refused with a typed reason. No IO, no authority — the caller decides how to
 * surface the notice (nudge / continue / end).
 */

export interface AddResult {
  admitted: boolean;
  clamped?: boolean;
  reason?: string;
}

export interface ThinkingBudget {
  add(text: string): AddResult;
  usedTokens(): number;
  remainingTokens(): number;
  estimate(text: string): number;
}

export interface ThinkingBudgetOptions {
  capTokens: number;
}

export function createThinkingBudget(opts: ThinkingBudgetOptions): ThinkingBudget {
  const cap = Math.floor(opts.capTokens);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error("HZ_PRECONDITION_FAILED: thinking budget cap must be positive");
  }
  const estimate = (s: string): number => Math.floor(new TextEncoder().encode(s).length / 4);
  let used = 0;
  let exhausted = false;

  return {
    estimate,
    add(text: string): AddResult {
      if (exhausted) return { admitted: false, reason: "thinking token budget exhausted" };
      const need = estimate(text);
      if (used + need <= cap) {
        used += need;
        if (used === cap) exhausted = true;
        return { admitted: true };
      }
      // Crossing delta: admit the remaining room, clamped, and mark exhausted.
      const room = Math.max(0, cap - used);
      used = cap;
      exhausted = true;
      return { admitted: true, clamped: true, reason: room === 0 ? "thinking token budget exhausted" : undefined };
    },
    usedTokens: () => used,
    remainingTokens: () => Math.max(0, cap - used),
  };
}

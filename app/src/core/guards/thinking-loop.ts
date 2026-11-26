import { detectNearDuplicateSegments, detectProgressLexiconStall } from "./thinking-loop-guard";

/**
 * thinking-loop.ts — reduced C-10 failure class (omp thinking-loop-redirect ADAPT).
 *
 * Detects repeated thinking / no-tool stalls:
 *  1. Exact suffix cycles inside thinking or assistant text (within one step).
 *  2. Consecutive no-tool steps that share the same normalized fingerprint.
 *
 * Soft → `<system-interrupt reason="thinking_loop">` nudge (via guard-prompt).
 * Hard → loop exits with detail `thinking_loop`.
 *
 * Not the full omp Jaccard / progress-lexicon detector; empty-response is a
 * separate C-10 residual. Disable with `HZ_THINKING_LOOP=0`.
 */

/** Soft nudge once this many identical no-tool stalls (or an exact cycle). */
export const NUDGE_AFTER_THINKING_STALLS = 2;
/** Hard stop once consecutive identical no-tool stalls reach this. */
export const MAX_THINKING_STALLS = 4;
/** Below this material length, the step is not a thinking-loop stall. */
export const MIN_THINKING_STALL_CHARS = 40;
/** Exact-cycle unit floor / ceiling and coverage (reduced omp EXACT_*). */
export const EXACT_CYCLE_MIN_UNIT = 16;
export const EXACT_CYCLE_MAX_UNIT = 256;
export const EXACT_CYCLE_MIN_REPEATS = 3;
export const EXACT_CYCLE_MIN_COVERED = 96;
export const EXACT_CYCLE_TAIL_WINDOW = 4096;

export interface ThinkingLoopStep {
  toolCallCount: number;
  thinkingText: string;
  assistantText: string;
  /** ADDITIVE: prose segments for the omp semantic detectors (opt-in). */
  segments?: readonly string[];
}

export interface ThinkingLoopVerdict {
  kind: "ok" | "soft" | "hard";
  message?: string;
  consecutiveCount?: number;
  reason?: "exact_cycle" | "repeated_fingerprint" | "near_duplicate_segments" | "progress_lexicon_stall";
}

export interface ThinkingLoopState {
  lastFingerprint: string;
  consecutiveIdentical: number;
}

export function createThinkingLoopState(): ThinkingLoopState {
  return { lastFingerprint: "", consecutiveIdentical: 0 };
}

export function resetThinkingLoopState(state: ThinkingLoopState): void {
  state.lastFingerprint = "";
  state.consecutiveIdentical = 0;
}

/** Collapse whitespace for fingerprint equality (near-identical prose). */
export function normalizeThinkingStallText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function thinkingStallMaterial(step: ThinkingLoopStep): string {
  const thinking = step.thinkingText.trim();
  const text = step.assistantText.trim();
  if (thinking === "") return text;
  if (text === "") return thinking;
  return `${thinking}\n${text}`;
}

export function thinkingStallFingerprint(step: ThinkingLoopStep): string {
  return normalizeThinkingStallText(thinkingStallMaterial(step));
}

/**
 * Reduced omp exact-suffix cycle: a unit of 16–256 chars repeated ≥3× at the
 * end of the tail, covering ≥96 characters.
 */
export function detectExactSuffixCycle(
  text: string,
): { unitLen: number; times: number } | null {
  const raw = text.length > EXACT_CYCLE_TAIL_WINDOW ? text.slice(-EXACT_CYCLE_TAIL_WINDOW) : text;
  if (raw.length < EXACT_CYCLE_MIN_COVERED) return null;
  const maxUnit = Math.min(EXACT_CYCLE_MAX_UNIT, Math.floor(raw.length / EXACT_CYCLE_MIN_REPEATS));
  for (let unitLen = maxUnit; unitLen >= EXACT_CYCLE_MIN_UNIT; unitLen -= 1) {
    if (raw.length < unitLen * EXACT_CYCLE_MIN_REPEATS) continue;
    const unit = raw.slice(-unitLen);
    let times = 1;
    let pos = raw.length - unitLen;
    while (pos >= unitLen && raw.slice(pos - unitLen, pos) === unit) {
      times += 1;
      pos -= unitLen;
    }
    if (times >= EXACT_CYCLE_MIN_REPEATS && times * unitLen >= EXACT_CYCLE_MIN_COVERED) {
      return { unitLen, times };
    }
  }
  return null;
}

/**
 * Advance state for one completed provider step. Tool calls reset the streak.
 * Soft fires on an exact cycle or when identical no-tool fingerprints hit the
 * soft threshold; hard at the max streak.
 */
export function checkThinkingLoopStep(
  state: ThinkingLoopState,
  step: ThinkingLoopStep,
): ThinkingLoopVerdict {
  if (step.toolCallCount > 0) {
    resetThinkingLoopState(state);
    return { kind: "ok" };
  }

  // ADDITIVE omp semantic detectors (must-steal #13): opt-in so the reduced
  // byte-identical path is preserved. They judge prose only; tool calls already
  // reset the streak above.
  if (step.segments !== undefined && step.segments.length > 0) {
    const raw = process.env.HZ_THINKING_LOOP_SEMANTIC?.trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "yes") {
      if (detectNearDuplicateSegments(step.segments)) {
        return { kind: "hard", reason: "near_duplicate_segments" };
      }
      if (detectProgressLexiconStall(step.segments)) {
        return { kind: "hard", reason: "progress_lexicon_stall" };
      }
    }
  }

  const material = thinkingStallMaterial(step);
  const cycle =
    detectExactSuffixCycle(step.thinkingText) ?? detectExactSuffixCycle(step.assistantText);
  if (material.length < MIN_THINKING_STALL_CHARS && cycle === null) {
    resetThinkingLoopState(state);
    return { kind: "ok" };
  }

  const fingerprint = thinkingStallFingerprint(step);
  if (fingerprint !== "" && fingerprint === state.lastFingerprint) {
    state.consecutiveIdentical += 1;
  } else {
    state.consecutiveIdentical = 1;
    state.lastFingerprint = fingerprint;
  }

  const count = state.consecutiveIdentical;
  const cycleSoft = cycle !== null;
  const fingerprintSoft = count >= NUDGE_AFTER_THINKING_STALLS;
  if (!cycleSoft && !fingerprintSoft) {
    return { kind: "ok", consecutiveCount: count };
  }

  const reason: "exact_cycle" | "repeated_fingerprint" = cycleSoft
    ? "exact_cycle"
    : "repeated_fingerprint";
  const detail =
    reason === "exact_cycle"
      ? `exact ${cycle!.unitLen}-character cycle ×${cycle!.times}`
      : `${count} consecutive identical no-tool stalls`;
  if (count >= MAX_THINKING_STALLS) {
    return {
      kind: "hard",
      message: `Detected thinking loop (${detail}); stopping to avoid a no-progress stall.`,
      consecutiveCount: count,
      reason,
    };
  }
  return {
    kind: "soft",
    message: `Detected thinking loop (${detail}); nudging the model to act or answer.`,
    consecutiveCount: count,
    reason,
  };
}

export class ThinkingLoopTracker {
  private readonly state: ThinkingLoopState = createThinkingLoopState();

  inspect(step: ThinkingLoopStep): ThinkingLoopVerdict {
    return checkThinkingLoopStep(this.state, step);
  }

  reset(): void {
    resetThinkingLoopState(this.state);
  }
}

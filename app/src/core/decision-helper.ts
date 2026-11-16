/**
 * Typed decision helper reduced (opencode C-11): deterministic `score` → `choice`
 * among thinking-effort rungs.
 *
 * Two paths live here, both fully local (no provider / model call):
 *
 * 1. `scoreTaskDifficulty` — the ORIGINAL cheap heuristic (unchanged, ruling
 *    216/464). Default-on routing uses this.
 * 2. `scoreTaskDifficultyCalibrated` — an opt-in LOCAL estimate built from
 *    documented deterministic input features (text length, tool count, prior
 *    step outcomes) and a reviewable prior table. It is NOT a statistically
 *    fitted model and NOT a live typed judge (docs/research/steal-opencode-cline.md
 *    §A.9 stays externally blocked). `probability` is a deterministic prior-based
 *    estimate in [0,1], not an empirically calibrated probability.
 *
 * Routing may opt in via `resolveDifficultyScore` / `calibratedDifficultyOptIn`.
 * Nothing here changes `HZ_THINKING_EFFORT` / `HZ_THINKING_AUTO` behavior unless
 * a caller explicitly wires the opt-in (this slice does not wire it).
 */

import type { ThinkingRung } from "./thinking-effort";
import { THINKING_RUNGS, capAtAutoThinkingCeiling } from "./thinking-effort";

export interface DecisionScore {
  value: number;
  reasons: string[];
}

export interface DecisionChoice<T> {
  pick: T;
  score: DecisionScore;
}

const HARD_SIGNALS = [/\brefactor\b/i, /\barchitect/i, /\bsecurity\b/i, /\bconcurrent\b/i, /\bperf(ormance)?\b/i];
const EASY_SIGNALS = [/\btypo\b/i, /\brename\b/i, /\bformat\b/i, /\blint\b/i, /\bcomment\b/i];

/** Heuristic difficulty in [0,1] from user text length and keywords. */
export function scoreTaskDifficulty(userText: string): DecisionScore {
  const reasons: string[] = [];
  let value = 0.35;
  const len = userText.trim().length;
  if (len > 1200) {
    value += 0.25;
    reasons.push("long_prompt");
  } else if (len < 80) {
    value -= 0.1;
    reasons.push("short_prompt");
  }
  for (const re of HARD_SIGNALS) {
    if (re.test(userText)) {
      value += 0.15;
      reasons.push(`hard:${re.source}`);
      break;
    }
  }
  for (const re of EASY_SIGNALS) {
    if (re.test(userText)) {
      value -= 0.12;
      reasons.push(`easy:${re.source}`);
      break;
    }
  }
  value = Math.min(1, Math.max(0, value));
  return { value, reasons };
}

/* -------------------------------------------------------------------------- */
/* C-11 local calibration (opt-in, deterministic, no provider call)           */
/* -------------------------------------------------------------------------- */

/** Prior-step outcome fed to the local calibrator; only failures raise difficulty. */
export type CalibrationOutcome = "success" | "failure" | "neutral" | "unknown";

/** Deterministic input features for the local estimate. All fields optional. */
export interface CalibrationFeatures {
  userText?: string;
  /** Number of tools available/considered on this turn (clamped, see priors). */
  toolCount?: number;
  /** Outcomes of earlier steps in this run; failures push difficulty up. */
  priorStepOutcomes?: readonly CalibrationOutcome[];
}

/**
 * Documented local prior table — the "data" behind the calibration slice.
 *
 * These are reviewable, fixed log-odds deltas from a neutral baseline, chosen so
 * the result agrees with the cheap heuristic on obvious cases while adding two
 * signals it lacks (tool surface, prior step outcomes). They are NOT learned
 * from a corpus and MUST NOT be described as statistically calibrated.
 */
export const LOCAL_CALIBRATION_PRIORS = Object.freeze({
  /** Baseline log-odds: ~0.40 difficulty before any evidence. */
  baseLogOdds: -0.4,
  /** userText.trim().length > 1200. */
  longPromptLogOdds: 0.9,
  /** userText.trim().length < 80. */
  shortPromptLogOdds: -0.7,
  /** Any hard keyword signal (reuses the heuristic's signal list). */
  hardKeywordLogOdds: 0.8,
  /** Any easy keyword signal (reuses the heuristic's signal list). */
  easyKeywordLogOdds: -0.6,
  /** Per-tool delta, capped by `toolCountCap` to bound the tool surface effect. */
  perToolLogOdds: 0.08,
  toolCountCap: 20,
  /** Per prior failure / success, capped by `priorOutcomeCap`. */
  priorFailureLogOdds: 0.55,
  priorSuccessLogOdds: -0.35,
  priorOutcomeCap: 6,
});

export interface CalibratedDifficulty extends DecisionScore {
  /** Deterministic prior-based estimate in [0,1] (NOT empirical calibration). */
  probability: number;
  /** Raw log-odds sum before the logistic squash (diagnostics / tests). */
  logOdds: number;
  /** The clamped feature values actually used, for auditability. */
  usedFeatures: {
    textLength: number;
    toolCount: number;
    priorFailures: number;
    priorSuccesses: number;
  };
}

function clampCount(value: number | undefined, cap: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(cap, Math.max(0, Math.trunc(value)));
}

function logistic(z: number): number {
  // Stable enough for the bounded log-odds this table produces.
  return 1 / (1 + Math.exp(-z));
}

/**
 * Local calibration path: deterministic features → probability-weighted
 * difficulty estimate. No provider call, no I/O, no global state. The returned
 * `value` equals `probability` so it can feed `chooseThinkingEffort` unchanged.
 */
export function scoreTaskDifficultyCalibrated(features: CalibrationFeatures): CalibratedDifficulty {
  const p = LOCAL_CALIBRATION_PRIORS;
  const text = typeof features.userText === "string" ? features.userText : "";
  const textLength = text.trim().length;
  const toolCount = clampCount(features.toolCount, p.toolCountCap);
  const outcomes = features.priorStepOutcomes ?? [];
  const priorFailures = clampCount(outcomes.filter((o) => o === "failure").length, p.priorOutcomeCap);
  const priorSuccesses = clampCount(outcomes.filter((o) => o === "success").length, p.priorOutcomeCap);

  const reasons: string[] = [];
  let logOdds = p.baseLogOdds;
  reasons.push("prior:base");

  if (textLength > 1200) {
    logOdds += p.longPromptLogOdds;
    reasons.push("long_prompt");
  } else if (textLength < 80) {
    logOdds += p.shortPromptLogOdds;
    reasons.push("short_prompt");
  }
  if (HARD_SIGNALS.some((re) => re.test(text))) {
    logOdds += p.hardKeywordLogOdds;
    reasons.push("hard_keyword");
  }
  if (EASY_SIGNALS.some((re) => re.test(text))) {
    logOdds += p.easyKeywordLogOdds;
    reasons.push("easy_keyword");
  }
  if (toolCount > 0) {
    logOdds += toolCount * p.perToolLogOdds;
    reasons.push(`tool_count:${toolCount}`);
  }
  if (priorFailures > 0) {
    logOdds += priorFailures * p.priorFailureLogOdds;
    reasons.push(`prior_failures:${priorFailures}`);
  }
  if (priorSuccesses > 0) {
    logOdds += priorSuccesses * p.priorSuccessLogOdds;
    reasons.push(`prior_successes:${priorSuccesses}`);
  }

  const probability = logistic(logOdds);
  return {
    value: probability,
    probability,
    logOdds,
    usedFeatures: { textLength, toolCount, priorFailures, priorSuccesses },
    reasons,
  };
}

/**
 * Opt-in env var name for routing to use the calibrated local estimate. Read
 * by `calibratedDifficultyOptIn`; this module never reads HZ_THINKING_EFFORT.
 */
export const CALIBRATED_DIFFICULTY_OPT_IN_ENV = "HZ_THINKING_CALIBRATED";

/** True for "1" / "true" / "yes" (case-insensitive); anything else is off. */
export function calibratedDifficultyOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[CALIBRATED_DIFFICULTY_OPT_IN_ENV];
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Self-documented opt-in selector for callers: legacy cheap heuristic by
 * default; calibrated local estimate only when explicitly opted in. Routing can
 * call this without changing HZ_THINKING_EFFORT semantics.
 */
export function resolveDifficultyScore(
  features: CalibrationFeatures,
  opts: { calibrated?: boolean; env?: Readonly<Record<string, string | undefined>> } = {},
): DecisionScore {
  const useCalibrated = opts.calibrated ?? calibratedDifficultyOptIn(opts.env ?? process.env);
  return useCalibrated ? scoreTaskDifficultyCalibrated(features) : scoreTaskDifficulty(features.userText ?? "");
}

/** Convenience: calibrated estimate → thinking rung (same ceiling mapping). */
export function autoThinkingEffortCalibrated(features: CalibrationFeatures): DecisionChoice<ThinkingRung> {
  return chooseThinkingEffort(scoreTaskDifficultyCalibrated(features));
}

/* -------------------------------------------------------------------------- */

/**
 * Map difficulty score to a thinking rung.
 * Auto ceiling is one tier below max (`high`); only `ultrathink` reaches `xhigh`.
 */
export function chooseThinkingEffort(score: DecisionScore): DecisionChoice<ThinkingRung> {
  let pick: ThinkingRung = "medium";
  if (score.value >= 0.72) pick = "high";
  else if (score.value >= 0.45) pick = "medium";
  else if (score.value >= 0.28) pick = "low";
  else pick = "minimal";
  return { pick: capAtAutoThinkingCeiling(pick), score };
}

export function autoThinkingEffortFromText(userText: string): DecisionChoice<ThinkingRung> {
  return chooseThinkingEffort(scoreTaskDifficulty(userText));
}

/** Export ladder for tests. */
export function thinkingRungs(): readonly ThinkingRung[] {
  return THINKING_RUNGS;
}

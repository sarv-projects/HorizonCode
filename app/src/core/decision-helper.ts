/**
 * Typed decision helper reduced (opencode C-11): deterministic `score` → `choice`
 * among thinking-effort rungs. No calibrated probabilities or model calls.
 */

import type { ThinkingRung } from "./thinking-effort";
import { THINKING_RUNGS } from "./thinking-effort";

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

/** Map difficulty score to a thinking rung (auto tier below max unless hard). */
export function chooseThinkingEffort(score: DecisionScore): DecisionChoice<ThinkingRung> {
  let pick: ThinkingRung = "medium";
  if (score.value >= 0.72) pick = "high";
  else if (score.value >= 0.45) pick = "medium";
  else if (score.value >= 0.28) pick = "low";
  else pick = "minimal";
  return { pick, score };
}

export function autoThinkingEffortFromText(userText: string): DecisionChoice<ThinkingRung> {
  return chooseThinkingEffort(scoreTaskDifficulty(userText));
}

/** Export ladder for tests. */
export function thinkingRungs(): readonly ThinkingRung[] {
  return THINKING_RUNGS;
}

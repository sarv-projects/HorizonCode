/**
 * G-9 reduced: locally computed benchmark stimuli — each trial is derived from an
 * index; the expected label is a deterministic function of (salt, index) so
 * paraphrase of the prompt cannot help without executing the derivation.
 */

import { createHash } from "node:crypto";

export const BENCH_STIMULUS_VERSION = 1;

export interface IndexedStimulus {
  index: number;
  /** Task text shown to the model (encodes index, not the answer). */
  prompt: string;
  /** Ground-truth token the grader expects in the final answer. */
  expectedToken: string;
  salt: string;
}

function deriveExpectedToken(salt: string, index: number): string {
  const h = createHash("sha256").update(`${salt}\n${index}`, "utf8").digest("hex");
  return `gt_${h.slice(0, 12)}`;
}

/**
 * Build one stimulus. The prompt asks the model to compute the token from the index
 * using the same rule (documented inline) — offline evals use a scripted executor
 * that returns the token without a model.
 */
export function stimulusFromIndex(index: number, salt = "hz-bench-v1"): IndexedStimulus {
  if (!Number.isFinite(index) || index < 0 || Math.floor(index) !== index) {
    throw new Error("bench: index must be a non-negative integer");
  }
  const expectedToken = deriveExpectedToken(salt, index);
  const prompt =
    `Benchmark trial #${index}. Compute the ground-truth token: SHA-256 of ` +
    `UTF-8 bytes "${salt}\\n${index}", lowercase hex, take the first 12 chars, ` +
    `prefix with "gt_". Reply with only that token.`;
  return { index, prompt, expectedToken, salt };
}

export function buildIndexedEvalCases(count: number, salt?: string): { id: string; task: string; expectedToken: string }[] {
  const cases: { id: string; task: string; expectedToken: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = stimulusFromIndex(i, salt);
    cases.push({ id: `bench-index-${i}`, task: s.prompt, expectedToken: s.expectedToken });
  }
  return cases;
}

/** Grade a final answer against an indexed case (substring match on expected token). */
export function gradeIndexedAnswer(expectedToken: string, finalAnswer: string): boolean {
  return finalAnswer.includes(expectedToken);
}

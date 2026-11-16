/**
 * G-9 reduced: locally computed benchmark stimuli — each trial is derived from an
 * index; the expected label is a deterministic function of (salt, index) so
 * paraphrase of the prompt cannot help without executing the derivation.
 */

import { createHash } from "node:crypto";
import { metricContract } from "./metrics";

export const BENCH_STIMULUS_VERSION = 1;

/**
 * H-7 / ruling 510 — metric contract (docs/16 §2.4.3) for bench ground truth.
 * This module is a pure stimulus factory: it has no runner, no result
 * population and no comparison baseline. Those slots are therefore honestly
 * "unknown" / "none — first measurement" — never fabricated. Every numeric
 * fact it publishes (stimulus version, stimulus index, cases built) goes
 * through `metricContract` into a `published` block.
 */
const BENCH_ANCHOR = "none — first measurement (no prior benchmark run to compare against)";
const BENCH_POPULATION =
  "unknown — no bench runner or result population is registered in this module (stimuli are consumed by an external harness)";
const BENCH_EXCLUDES = "none — deterministic derivation from (salt, index); no trials are discarded here";

/** The module-level numeric facts, contracted even when no stimulus is built. */
export function benchGroundTruthPublication(): string[] {
  return [
    metricContract({
      metric: "bench stimulus version",
      anchor: BENCH_ANCHOR,
      population: BENCH_POPULATION,
      excludes: BENCH_EXCLUDES,
      value: BENCH_STIMULUS_VERSION,
    }),
  ];
}

export interface IndexedStimulus {
  index: number;
  /** Task text shown to the model (encodes index, not the answer). */
  prompt: string;
  /** Ground-truth token the grader expects in the final answer. */
  expectedToken: string;
  salt: string;
  /** H-7/ruling 510: contracted numeric facts this stimulus publishes. */
  published: string[];
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
  const published = [
    ...benchGroundTruthPublication(),
    metricContract({
      metric: "bench stimulus index",
      anchor: BENCH_ANCHOR,
      population: BENCH_POPULATION,
      excludes: BENCH_EXCLUDES,
      value: index,
    }),
  ];
  return { index, prompt, expectedToken, salt, published };
}

export interface IndexedEvalCase {
  id: string;
  task: string;
  expectedToken: string;
  /** H-7/ruling 510: contracted numeric facts published for this case set. */
  published: string[];
}

export function buildIndexedEvalCases(count: number, salt?: string): IndexedEvalCase[] {
  const cases: IndexedEvalCase[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = stimulusFromIndex(i, salt);
    cases.push({
      id: `bench-index-${i}`,
      task: s.prompt,
      expectedToken: s.expectedToken,
      published: [
        ...s.published,
        metricContract({
          metric: "indexed bench eval cases built in set",
          anchor: BENCH_ANCHOR,
          population: BENCH_POPULATION,
          excludes: BENCH_EXCLUDES,
          value: count,
        }),
      ],
    });
  }
  return cases;
}

/** Grade a final answer against an indexed case (substring match on expected token). */
export function gradeIndexedAnswer(expectedToken: string, finalAnswer: string): boolean {
  return finalAnswer.includes(expectedToken);
}

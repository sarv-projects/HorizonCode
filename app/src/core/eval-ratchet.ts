/**
 * eval-ratchet.ts — G-8: the ON-DISK variant gate in the eval runner.
 *
 * Ruling 503 shipped the pure keep/revert machinery (`decideRatchetRound`,
 * `splitScoresFromResults`, the append-only decision log) in `eval-approval.ts`
 * but left "on-disk variant gate wiring in the eval runner" OPEN. This module is
 * that wiring, kept separate from the CLI so it is hermetically testable:
 *
 *   - load an approval with a FROZEN split from disk (fail closed when absent),
 *   - load baseline + candidate per-case results from disk,
 *   - score both sides of the frozen split and decide keep/revert PURELY,
 *   - persist the decision to an append-only JSONL log (never overwrite a keep).
 *
 * Every number published here goes through `metricContract` (H-7): the report
 * carries contracted blocks, not bare numbers.
 */

import { readFileSync } from "node:fs";
import type { CasePassRow } from "./eval-approval";
import {
  appendRatchetDecision,
  buildRatchetDecisionRecord,
  decideRatchetRound,
  parseEvalApproval,
  splitScoresFromResults,
  type AppendRatchetDecisionResult,
  type RatchetDecision,
  type RatchetDecisionRecord,
} from "./eval-approval";
import { metricContract } from "./metrics";

/** The on-disk gate spec (content of the `--ratchet <spec.json>` file). */
export interface RatchetGateSpec {
  /** Path to the approval JSON carrying the frozen split. */
  approval: string;
  /** Path to the baseline results JSON (array of `{id, passed}`). */
  baseline: string;
  /** Path to the candidate results JSON (array of `{id, passed}`). */
  candidate: string;
  variantId: string;
  round: number;
  /** Append-only decision log path. */
  decisionLog: string;
  /** Deterministic decision timestamp (tests); default is the wall clock. */
  decidedAt?: string;
  keepOnTrainNotWorse?: boolean;
}

export function parseRatchetGateSpec(text: string, file: string): RatchetGateSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: ratchet spec is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const row = raw as Partial<RatchetGateSpec> | null;
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${file}: ratchet spec must be an object`);
  }
  for (const key of ["approval", "baseline", "candidate", "decisionLog"] as const) {
    if (typeof row[key] !== "string" || row[key]!.trim() === "") {
      throw new Error(`${file}: ratchet spec needs a non-blank ${key}`);
    }
  }
  if (typeof row.variantId !== "string" || row.variantId.trim() === "") {
    throw new Error(`${file}: ratchet spec needs a non-blank variantId`);
  }
  if (!Number.isInteger(row.round) || (row.round ?? -1) < 0) {
    throw new Error(`${file}: ratchet spec round must be a non-negative integer`);
  }
  if (row.decidedAt !== undefined && typeof row.decidedAt !== "string") {
    throw new Error(`${file}: ratchet spec decidedAt must be a string`);
  }
  if (row.keepOnTrainNotWorse !== undefined && typeof row.keepOnTrainNotWorse !== "boolean") {
    throw new Error(`${file}: ratchet spec keepOnTrainNotWorse must be a boolean`);
  }
  return {
    approval: row.approval!,
    baseline: row.baseline!,
    candidate: row.candidate!,
    decisionLog: row.decisionLog!,
    variantId: row.variantId!,
    round: row.round!,
    ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
    ...(row.keepOnTrainNotWorse !== undefined ? { keepOnTrainNotWorse: row.keepOnTrainNotWorse } : {}),
  };
}

/**
 * Load per-case results. Accepts `{id, passed}` or `{caseId, passed}` rows.
 * Fail closed on a non-array, a non-object row, a missing/blank id, or a
 * non-boolean `passed` — an unreadable result is never "all failed" (which
 * would silently revert a variant).
 */
export function loadVariantResults(file: string): CasePassRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: variant results are not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(raw)) throw new Error(`${file}: variant results must be a JSON array`);
  return raw.map((entry, index) => {
    const row = entry as { id?: unknown; caseId?: unknown; passed?: unknown } | null;
    if (row === null || typeof row !== "object") {
      throw new Error(`${file}[${index}]: result row is not an object`);
    }
    const id = typeof row.id === "string" ? row.id : typeof row.caseId === "string" ? row.caseId : "";
    if (id.trim() === "") throw new Error(`${file}[${index}]: result row has no id/caseId`);
    if (typeof row.passed !== "boolean") {
      throw new Error(`${file}[${index}] (${id}): passed must be a boolean`);
    }
    return { id, passed: row.passed };
  });
}

const GATE_ANCHOR = "none — first ratchet round for this variant";
const GATE_EXCLUDES = "none — every frozen-split case is scored; no result row is discarded";

export interface RatchetGateReport {
  verdict: RatchetDecision["verdict"];
  reason: string;
  tieBreak: boolean;
  variantId: string;
  round: number;
  record: RatchetDecisionRecord;
  append: AppendRatchetDecisionResult;
  /** H-7: contracted numeric facts about this round. */
  published: string[];
}

/**
 * Run the on-disk gate: validate spec + approval + results, decide, persist.
 * Idempotent: a byte-identical record already in the log is a no-op; a
 * different decision for a KEPT key is refused by `appendRatchetDecision`.
 */
export function runRatchetGate(spec: RatchetGateSpec): RatchetGateReport {
  const approvalText = readFileSync(spec.approval, "utf8");
  const approval = parseEvalApproval(approvalText, spec.approval);
  if (approval.frozenSplit === undefined) {
    throw new Error(`${spec.approval}: ratchet gate needs an approval with a frozenSplit (re-approve with --held-out-fraction)`);
  }
  const baseline = loadVariantResults(spec.baseline);
  const candidate = loadVariantResults(spec.candidate);
  const metrics = splitScoresFromResults(approval.frozenSplit, baseline, candidate);
  const rule = spec.keepOnTrainNotWorse !== undefined ? { keepOnTrainNotWorse: spec.keepOnTrainNotWorse } : {};
  const decision = decideRatchetRound(metrics, rule);
  const record = buildRatchetDecisionRecord(
    {
      round: spec.round,
      variantId: spec.variantId,
      split: approval.frozenSplit,
      metrics,
      rule,
      approvalHash: approval.casesContentHash,
    },
    spec.decidedAt !== undefined ? { now: () => spec.decidedAt! } : {},
  );
  const append = appendRatchetDecision(spec.decisionLog, record);
  const population = `${baseline.length} baseline + ${candidate.length} candidate result row(s) on the frozen split (approval ${approval.casesContentHash})`;
  const published = [
    metricContract({ metric: "ratchet baseline held-out pass rate", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: decision.baselineHeldOutRate.toFixed(4) }),
    metricContract({ metric: "ratchet candidate held-out pass rate", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: decision.candidateHeldOutRate.toFixed(4) }),
    metricContract({ metric: "ratchet round", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: spec.round }),
  ];
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    tieBreak: decision.tieBreak,
    variantId: spec.variantId,
    round: spec.round,
    record,
    append,
    published,
  };
}

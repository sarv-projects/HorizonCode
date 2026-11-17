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
import { canonicalJson, sha256Hex } from "./canon";
import type { CasePassRow, EvalFrozenSplitV1 } from "./eval-approval";
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

interface DecideAndAppendInput {
  frozenSplit: EvalFrozenSplitV1;
  approvalHash: string;
  baseline: CasePassRow[];
  candidate: CasePassRow[];
  round: number;
  variantId: string;
  decisionLog: string;
  decidedAt?: string;
  keepOnTrainNotWorse?: boolean;
}

/**
 * The single decision+append path shared by the on-disk gate and the automatic
 * post-run feed. Everything here is unchanged from the shipped `--ratchet` gate:
 * pure split scoring, a hashed decision record, and an append-only log that is
 * idempotent on an identical record and refuses to overwrite a kept result.
 */
function decideAndAppend(input: DecideAndAppendInput): RatchetGateReport {
  const metrics = splitScoresFromResults(input.frozenSplit, input.baseline, input.candidate);
  const rule = input.keepOnTrainNotWorse !== undefined ? { keepOnTrainNotWorse: input.keepOnTrainNotWorse } : {};
  const decision = decideRatchetRound(metrics, rule);
  const record = buildRatchetDecisionRecord(
    {
      round: input.round,
      variantId: input.variantId,
      split: input.frozenSplit,
      metrics,
      rule,
      approvalHash: input.approvalHash,
    },
    input.decidedAt !== undefined ? { now: () => input.decidedAt! } : {},
  );
  const append = appendRatchetDecision(input.decisionLog, record);
  const population = `${input.baseline.length} baseline + ${input.candidate.length} candidate result row(s) on the frozen split (approval ${input.approvalHash})`;
  const published = [
    metricContract({ metric: "ratchet baseline held-out pass rate", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: decision.baselineHeldOutRate.toFixed(4) }),
    metricContract({ metric: "ratchet candidate held-out pass rate", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: decision.candidateHeldOutRate.toFixed(4) }),
    metricContract({ metric: "ratchet round", anchor: GATE_ANCHOR, population, excludes: GATE_EXCLUDES, value: input.round }),
  ];
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    tieBreak: decision.tieBreak,
    variantId: input.variantId,
    round: input.round,
    record,
    append,
    published,
  };
}

/** Load an approval from disk and require the frozen split the gate needs. */
function approvalForGate(approvalPath: string): ReturnType<typeof parseEvalApproval> {
  const approval = parseEvalApproval(readFileSync(approvalPath, "utf8"), approvalPath);
  if (approval.frozenSplit === undefined) {
    throw new Error(`${approvalPath}: ratchet gate needs an approval with a frozenSplit (re-approve with --held-out-fraction)`);
  }
  return approval;
}

/**
 * Run the on-disk gate: validate spec + approval + results, decide, persist.
 * Idempotent: a byte-identical record already in the log is a no-op; a
 * different decision for a KEPT key is refused by `appendRatchetDecision`.
 */
export function runRatchetGate(spec: RatchetGateSpec): RatchetGateReport {
  const approval = approvalForGate(spec.approval);
  const baseline = loadVariantResults(spec.baseline);
  const candidate = loadVariantResults(spec.candidate);
  return decideAndAppend({
    frozenSplit: approval.frozenSplit!,
    approvalHash: approval.casesContentHash,
    baseline,
    candidate,
    round: spec.round,
    variantId: spec.variantId,
    decisionLog: spec.decisionLog,
    ...(spec.decidedAt !== undefined ? { decidedAt: spec.decidedAt } : {}),
    ...(spec.keepOnTrainNotWorse !== undefined ? { keepOnTrainNotWorse: spec.keepOnTrainNotWorse } : {}),
  });
}

/* ------------------------- automatic post-run feed (G-8) ------------------------- */

/**
 * Load the result file a normal eval run just produced. Accepts the `{cases:[...]}`
 * wrapper written by `--metrics-out`, a flat `{caseId, passed}` array, or the
 * plain `{id, passed}` array the on-disk gate already accepts. Anything else (missing, non-JSON, wrong shape,
 * non-boolean passed) fails closed — a corrupt result is never "all failed".
 */
export function loadRunResults(file: string): CasePassRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: eval run result file is missing or not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const rows: unknown = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.cases)
      ? raw.cases
      : undefined;
  if (!Array.isArray(rows)) {
    throw new Error(`${file}: eval run result file must be an array of {caseId, passed} or a {cases:[...]} report`);
  }
  return rows.map((entry, index) => {
    const row = entry as { id?: unknown; caseId?: unknown; passed?: unknown } | null;
    if (row === null || typeof row !== "object") {
      throw new Error(`${file}[${index}]: result row is not an object`);
    }
    const id = typeof row.caseId === "string" ? row.caseId : typeof row.id === "string" ? row.id : "";
    if (id.trim() === "") throw new Error(`${file}[${index}]: result row has no caseId/id`);
    if (typeof row.passed !== "boolean") {
      throw new Error(`${file}[${index}] (${id}): passed must be a boolean`);
    }
    return { id, passed: row.passed };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface AutoRatchetRunInput {
  /** The gate spec (approval, baseline, decisionLog, variantId, round). */
  spec: RatchetGateSpec;
  /** The run's own result file (metrics-out), fed as the candidate. */
  resultFile: string;
}

/**
 * Automatic post-run feed: after a normal eval run, feed the run's own result
 * file into the SAME ratchet decision as `--ratchet` (no new decision logic).
 * The spec's `candidate` field is ignored; the run result file is the candidate.
 * When the spec pins no `decidedAt`, the decision timestamp is derived from the
 * PASS/FAIL rows (not the volatile per-case timing/cost fields) so replaying a
 * run with the same outcomes is idempotent by construction.
 */
export function runAutoRatchet(input: AutoRatchetRunInput): RatchetGateReport {
  const candidate = loadRunResults(input.resultFile);
  const approval = approvalForGate(input.spec.approval);
  const baseline = loadVariantResults(input.spec.baseline);
  const decidedAt =
    input.spec.decidedAt ?? `auto:${sha256Hex(canonicalJson(candidate))}`;
  return decideAndAppend({
    frozenSplit: approval.frozenSplit!,
    approvalHash: approval.casesContentHash,
    baseline,
    candidate,
    round: input.spec.round,
    variantId: input.spec.variantId,
    decisionLog: input.spec.decisionLog,
    decidedAt,
    ...(input.spec.keepOnTrainNotWorse !== undefined ? { keepOnTrainNotWorse: input.spec.keepOnTrainNotWorse } : {}),
  });
}

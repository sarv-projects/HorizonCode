/**
 * eval-approval.ts — eval hillclimb approval freshness + frozen split + held-out
 * leakage (docs/30 G-8).
 *
 * A human (or CI) records approval of a case set in a small JSON file. Before a
 * run, the runner checks that the on-disk cases still match `casesContentHash`.
 * When `frozenSplit` is present, the host also refuses any train/held-out
 * reassignment that does not match the recorded partition (omp ratchet spirit:
 * the model must not be able to argue with the split).
 *
 * `assertHeldOutLeakage` refuses train-side case ids / traces that name a
 * frozen held-out id (omp: traces are train-only). The ratchet section below
 * adds full keep/revert rounds: a documented decision per round driven by the
 * frozen-split metrics (held-out pass rate first, train as the tie-break),
 * persisted to an append-only decision log that never overwrites a kept result.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "../contracts";
import type { PostmortemEvalCase } from "./evals";

/** Host-owned train / held-out partition recorded with an approval. */
export interface EvalFrozenSplitV1 {
  trainIds: string[];
  heldOutIds: string[];
  /** Seed that reproduces the partition via `buildFrozenSplit`. */
  splitSeed: number;
  /** sha256 of canonical `{ trainIds, heldOutIds }` (sorted). */
  splitHash: string;
}

export interface EvalApprovalV1 {
  version: 1;
  casesContentHash: string;
  approvedAt: string;
  note?: string;
  /** Optional host-frozen train/held-out ids (G-8 frozen split). */
  frozenSplit?: EvalFrozenSplitV1;
}

export interface BuildFrozenSplitOptions {
  /** Fraction of cases assigned to held-out (exclusive of 0 and 1). Default 0.4. */
  heldOutFraction?: number;
  /** Deterministic seed; default 1 when omitted. */
  splitSeed?: number;
}

/** Stable digest over case ids and tasks (ignores assertions ordering noise). */
export function casesContentHash(cases: readonly PostmortemEvalCase[]): string {
  const rows = cases
    .map((c) => ({ id: c.id, task: c.task }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(canonicalJson(rows));
}

/** Digest binding a frozen train/held-out partition. */
export function frozenSplitHash(trainIds: readonly string[], heldOutIds: readonly string[]): string {
  const train = [...trainIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const heldOut = [...heldOutIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(canonicalJson({ heldOutIds: heldOut, trainIds: train }));
}

/** Seeded PRNG (mulberry32) so a recorded seed reproduces the split. */
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a host-owned train/held-out partition over case ids.
 * Needs at least 2 distinct ids so both sides are non-empty.
 */
export function buildFrozenSplit(
  caseIds: readonly string[],
  opts: BuildFrozenSplitOptions = {},
): EvalFrozenSplitV1 {
  const heldOutFraction = opts.heldOutFraction ?? 0.4;
  if (!(heldOutFraction > 0 && heldOutFraction < 1)) {
    throw new Error(`heldOutFraction must be between 0 and 1 (got ${heldOutFraction})`);
  }
  const splitSeed = opts.splitSeed ?? 1;
  if (!Number.isInteger(splitSeed) || splitSeed < 0) {
    throw new Error(`splitSeed must be a non-negative integer (got ${splitSeed})`);
  }
  const unique = [...new Set(caseIds.map((id) => id.trim()).filter((id) => id !== ""))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (unique.length < 2) {
    throw new Error(`frozen split needs at least 2 distinct case ids (got ${unique.length})`);
  }
  const bucket = [...unique];
  const random = seededRandom(splitSeed);
  for (let index = bucket.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const tmp = bucket[index]!;
    bucket[index] = bucket[swap]!;
    bucket[swap] = tmp;
  }
  let heldOutCount = Math.round(bucket.length * heldOutFraction);
  if (heldOutCount <= 0) heldOutCount = 1;
  if (heldOutCount >= bucket.length) heldOutCount = bucket.length - 1;
  const heldOutIds = bucket.slice(0, heldOutCount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const trainIds = bucket.slice(heldOutCount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    trainIds,
    heldOutIds,
    splitSeed,
    splitHash: frozenSplitHash(trainIds, heldOutIds),
  };
}

/** Refuse when the current case set does not match the frozen partition. */
export function assertEvalFrozenSplit(
  cases: readonly PostmortemEvalCase[],
  split: EvalFrozenSplitV1,
): void {
  const expectedHash = frozenSplitHash(split.trainIds, split.heldOutIds);
  if (split.splitHash !== expectedHash) {
    throw new Error(
      `frozen split corrupt (splitHash ${split.splitHash} ≠ recomputed ${expectedHash})`,
    );
  }
  const train = new Set(split.trainIds);
  const heldOut = new Set(split.heldOutIds);
  if (train.size !== split.trainIds.length) {
    throw new Error("frozen split trainIds contain duplicates");
  }
  if (heldOut.size !== split.heldOutIds.length) {
    throw new Error("frozen split heldOutIds contain duplicates");
  }
  if (train.size === 0 || heldOut.size === 0) {
    throw new Error("frozen split requires non-empty trainIds and heldOutIds");
  }
  for (const id of train) {
    if (heldOut.has(id)) {
      throw new Error(`frozen split overlap: case id ${id} is in both train and held-out`);
    }
  }
  const current = new Set(cases.map((c) => c.id));
  if (current.size !== cases.length) {
    throw new Error("case set has duplicate ids; cannot assert frozen split");
  }
  const union = new Set<string>([...train, ...heldOut]);
  if (union.size !== current.size) {
    throw new Error(
      `frozen split stale: recorded ${union.size} id(s) but current case set has ${current.size}`,
    );
  }
  for (const id of union) {
    if (!current.has(id)) {
      throw new Error(`frozen split stale: recorded id ${id} is missing from the current case set`);
    }
  }
  for (const id of current) {
    if (!union.has(id)) {
      throw new Error(`frozen split stale: case id ${id} is outside the frozen train/held-out partition`);
    }
  }
}

/**
 * omp-style train transcript basename → case id.
 * Matches `{caseId}_rep{N}.json` (N digits); returns null when the name does not match.
 */
export function evalTraceCaseId(filename: string): string | null {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const match = /^(.*)_rep\d+\.json$/i.exec(base);
  if (match === null || match[1] === undefined || match[1] === "") return null;
  return match[1];
}

/** Resolve a train-trace probe entry to a case id (rep filename or bare id). */
function resolveTrainTraceCaseId(entry: string): string {
  const fromRep = evalTraceCaseId(entry);
  if (fromRep !== null) return fromRep;
  const base = entry.replace(/\\/g, "/").split("/").pop() ?? entry;
  return base.replace(/\.json$/i, "");
}

/** Train-side material the host must keep free of held-out ids. */
export interface HeldOutLeakageProbe {
  /** Case ids present on the train side (results rows, train view, etc.). */
  trainCaseIds?: readonly string[];
  /**
   * Trace basenames / paths (`{id}_rep0.json`) or raw case ids claimed as
   * train-only transcripts. Held-out ids here are leakage.
   */
  trainTraces?: readonly string[];
}

/**
 * Host-owned held-out isolation (G-8): train must not contain held-out case ids
 * or traces. Call after a frozen split is recorded; keep/revert rounds are separate.
 */
export function assertHeldOutLeakage(split: EvalFrozenSplitV1, probe: HeldOutLeakageProbe): void {
  const expectedHash = frozenSplitHash(split.trainIds, split.heldOutIds);
  if (split.splitHash !== expectedHash) {
    throw new Error(
      `held-out leakage check refused: frozen split corrupt (splitHash ${split.splitHash} ≠ recomputed ${expectedHash})`,
    );
  }
  const heldOut = new Set(split.heldOutIds);
  if (heldOut.size === 0) {
    throw new Error("held-out leakage check refused: frozen split heldOutIds is empty");
  }

  const leakedCaseIds: string[] = [];
  for (const id of probe.trainCaseIds ?? []) {
    if (heldOut.has(id)) leakedCaseIds.push(id);
  }

  const leakedTraces: string[] = [];
  for (const entry of probe.trainTraces ?? []) {
    const caseId = resolveTrainTraceCaseId(entry);
    if (heldOut.has(caseId)) leakedTraces.push(entry);
  }

  if (leakedCaseIds.length === 0 && leakedTraces.length === 0) return;

  const parts: string[] = [];
  if (leakedCaseIds.length > 0) {
    const shown = [...new Set(leakedCaseIds)].slice(0, 5).join(", ");
    parts.push(`train case ids include held-out (${shown})`);
  }
  if (leakedTraces.length > 0) {
    const shown = leakedTraces.slice(0, 5).join(", ");
    parts.push(`train traces include held-out (${shown})`);
  }
  throw new Error(
    `held-out leakage: ${parts.join("; ")} — runner must keep train case ids / traces train-only`,
  );
}

export function buildEvalApproval(
  cases: readonly PostmortemEvalCase[],
  note?: string,
  frozenSplit?: EvalFrozenSplitV1,
): EvalApprovalV1 {
  if (frozenSplit !== undefined) assertEvalFrozenSplit(cases, frozenSplit);
  return {
    version: 1,
    casesContentHash: casesContentHash(cases),
    approvedAt: new Date().toISOString(),
    ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
    ...(frozenSplit !== undefined ? { frozenSplit } : {}),
  };
}

function parseFrozenSplit(raw: unknown, file: string): EvalFrozenSplitV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: approval frozenSplit must be an object`);
  }
  const row = raw as Partial<EvalFrozenSplitV1>;
  if (!Array.isArray(row.trainIds) || !row.trainIds.every((id) => typeof id === "string")) {
    throw new Error(`${file}: approval frozenSplit.trainIds must be a string array`);
  }
  if (!Array.isArray(row.heldOutIds) || !row.heldOutIds.every((id) => typeof id === "string")) {
    throw new Error(`${file}: approval frozenSplit.heldOutIds must be a string array`);
  }
  if (typeof row.splitSeed !== "number" || !Number.isInteger(row.splitSeed) || row.splitSeed < 0) {
    throw new Error(`${file}: approval frozenSplit.splitSeed must be a non-negative integer`);
  }
  if (typeof row.splitHash !== "string" || row.splitHash.length !== 64) {
    throw new Error(`${file}: approval frozenSplit.splitHash must be a 64-char sha256 hex digest`);
  }
  return {
    trainIds: row.trainIds,
    heldOutIds: row.heldOutIds,
    splitSeed: row.splitSeed,
    splitHash: row.splitHash,
  };
}

export function parseEvalApproval(text: string, file: string): EvalApprovalV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: approval file is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const row = parsed as Partial<EvalApprovalV1>;
  if (row.version !== 1) throw new Error(`${file}: approval version must be 1`);
  if (typeof row.casesContentHash !== "string" || row.casesContentHash.length !== 64) {
    throw new Error(`${file}: approval casesContentHash must be a 64-char sha256 hex digest`);
  }
  if (typeof row.approvedAt !== "string" || row.approvedAt.trim() === "") {
    throw new Error(`${file}: approval approvedAt is required`);
  }
  const frozenSplit =
    row.frozenSplit === undefined ? undefined : parseFrozenSplit(row.frozenSplit, file);
  return {
    version: 1,
    casesContentHash: row.casesContentHash,
    approvedAt: row.approvedAt,
    note: typeof row.note === "string" ? row.note : undefined,
    ...(frozenSplit !== undefined ? { frozenSplit } : {}),
  };
}

/** Refuses when the approval file does not match the current case set (and frozen split when present). */
export function assertEvalApprovalFresh(cases: readonly PostmortemEvalCase[], approvalPath: string): void {
  const text = readFileSync(approvalPath, "utf8");
  const approval = parseEvalApproval(text, approvalPath);
  const current = casesContentHash(cases);
  if (current !== approval.casesContentHash) {
    throw new Error(
      `${approvalPath}: approval stale (casesContentHash ${approval.casesContentHash} ≠ current ${current}) — re-approve before hillclimb`,
    );
  }
  if (approval.frozenSplit !== undefined) {
    try {
      assertEvalFrozenSplit(cases, approval.frozenSplit);
    } catch (err) {
      throw new Error(
        `${approvalPath}: ${err instanceof Error ? err.message : String(err)} — re-approve before hillclimb`,
      );
    }
  }
}

/* ============================ ratchet keep/revert (G-8) ============================ */

/**
 * Full keep/revert rounds. The decision is a pure function of the frozen-split
 * metrics so it is reproducible from an approval + case results:
 *
 *   1. Held-out pass rate is the PRIMARY signal (the unbiased split).
 *      Candidate > baseline → keep; candidate < baseline → revert.
 *   2. TIE-BREAK (documented, deterministic): when held-out rates are exactly
 *      equal, keep iff the candidate's train pass rate is >= baseline's.
 *      With no train metrics the default is KEEP ("no regression on the
 *      unbiased split"): a simplification that does not hurt held-out is kept.
 *      Set `keepOnTrainNotWorse: false` to invert the train tie-break / default.
 *
 * All comparisons use integer cross-multiplication (no float rounding). A
 * decision is recorded append-only and a previously KEPT result is never
 * silently overwritten (see `appendRatchetDecision`).
 */

export type RatchetVerdict = "keep" | "revert";

export type RatchetErrorReason =
  | "invalid-metrics"
  | "invalid-record"
  | "corrupt-log"
  | "split-mismatch"
  | "kept-result-overwrite";

export class RatchetError extends Error {
  readonly reason: RatchetErrorReason;
  readonly detail: string;

  constructor(reason: RatchetErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RatchetError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Pass/total on one side of the frozen split. */
export interface EvalSplitScore {
  passed: number;
  total: number;
}

export interface RatchetRoundMetrics {
  baselineHeldOut: EvalSplitScore;
  candidateHeldOut: EvalSplitScore;
  /** Optional train-side scores, used only for the documented tie-break. */
  baselineTrain?: EvalSplitScore;
  candidateTrain?: EvalSplitScore;
}

export interface RatchetTieBreakRule {
  /** Default true: on a held-out tie, keep iff candidate train >= baseline train. */
  keepOnTrainNotWorse?: boolean;
}

export interface RatchetDecision {
  verdict: RatchetVerdict;
  reason: string;
  /** True when the held-out rates tied and the train rule decided. */
  tieBreak: boolean;
  baselineHeldOutRate: number;
  candidateHeldOutRate: number;
  baselineTrainRate?: number;
  candidateTrainRate?: number;
}

function checkScore(score: EvalSplitScore | undefined, label: string): void {
  if (score === undefined) return;
  if (
    score === null ||
    typeof score !== "object" ||
    !Number.isInteger(score.total) ||
    !Number.isInteger(score.passed) ||
    score.total < 1 ||
    score.passed < 0 ||
    score.passed > score.total
  ) {
    throw new RatchetError(
      "invalid-metrics",
      `${label} must be { passed, total } integers with 0 <= passed <= total and total >= 1`,
    );
  }
}

function rate(score: EvalSplitScore): number {
  return score.passed / score.total;
}

/** Compare passed/total exactly (avoids floating-point tie drift). */
function compareScore(a: EvalSplitScore, b: EvalSplitScore): -1 | 0 | 1 {
  const left = a.passed * b.total;
  const right = b.passed * a.total;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Pure, documented keep/revert decision for one ratchet round. */
export function decideRatchetRound(
  metrics: RatchetRoundMetrics,
  rule: RatchetTieBreakRule = {},
): RatchetDecision {
  checkScore(metrics?.baselineHeldOut, "baselineHeldOut");
  checkScore(metrics?.candidateHeldOut, "candidateHeldOut");
  checkScore(metrics?.baselineTrain, "baselineTrain");
  checkScore(metrics?.candidateTrain, "candidateTrain");
  if (metrics === null || typeof metrics !== "object") {
    throw new RatchetError("invalid-metrics", "metrics must be an object");
  }

  const heldOutCmp = compareScore(metrics.candidateHeldOut, metrics.baselineHeldOut);
  const base: RatchetDecision = {
    verdict: "keep",
    reason: "",
    tieBreak: false,
    baselineHeldOutRate: rate(metrics.baselineHeldOut),
    candidateHeldOutRate: rate(metrics.candidateHeldOut),
    ...(metrics.baselineTrain !== undefined ? { baselineTrainRate: rate(metrics.baselineTrain) } : {}),
    ...(metrics.candidateTrain !== undefined ? { candidateTrainRate: rate(metrics.candidateTrain) } : {}),
  };
  if (heldOutCmp > 0) return { ...base, verdict: "keep", reason: "held-out pass rate improved" };
  if (heldOutCmp < 0) return { ...base, verdict: "revert", reason: "held-out pass rate regressed" };

  // Tie on the frozen held-out split → documented train tie-break.
  const keepOnTrainNotWorse = rule.keepOnTrainNotWorse ?? true;
  const trainTie =
    metrics.baselineTrain === undefined ||
    metrics.candidateTrain === undefined ||
    compareScore(metrics.candidateTrain, metrics.baselineTrain) === 0;
  const trainNotWorse =
    metrics.baselineTrain !== undefined &&
    metrics.candidateTrain !== undefined &&
    compareScore(metrics.candidateTrain, metrics.baselineTrain) >= 0;
  const keep = trainTie ? keepOnTrainNotWorse : keepOnTrainNotWorse && trainNotWorse;
  const reason = trainTie
    ? keepOnTrainNotWorse
      ? "held-out tie; no train regression, default keep"
      : "held-out tie; train rule inverted, default revert"
    : trainNotWorse
      ? "held-out tie; candidate train pass rate >= baseline"
      : "held-out tie; candidate train pass rate < baseline";
  return { ...base, verdict: keep ? "keep" : "revert", tieBreak: true, reason };
}

/** One graded case on a split side; `id` is a frozen-split case id. */
export interface CasePassRow {
  id: string;
  passed: boolean;
}

/**
 * Derive ratchet metrics from graded baseline/candidate case results on the
 * FROZEN split. Both lists must cover exactly the recorded train ∪ held-out
 * ids, so a round cannot quietly score a different case set.
 */
export function splitScoresFromResults(
  split: EvalFrozenSplitV1,
  baseline: readonly CasePassRow[],
  candidate: readonly CasePassRow[],
): RatchetRoundMetrics {
  const expected = frozenSplitHash(split.trainIds, split.heldOutIds);
  if (split.splitHash !== expected) {
    throw new RatchetError("split-mismatch", `frozen split corrupt (splitHash ${split.splitHash} ≠ ${expected})`);
  }
  const union = new Set<string>([...split.trainIds, ...split.heldOutIds]);
  for (const [label, rows] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    const ids = rows.map((row) => row.id);
    if (ids.length !== new Set(ids).size) throw new RatchetError("invalid-metrics", `${label} results contain duplicate ids`);
    if (ids.length !== union.size || ids.some((id) => !union.has(id))) {
      throw new RatchetError("invalid-metrics", `${label} results must cover exactly the frozen split ids`);
    }
  }
  const scoreFor = (rows: readonly CasePassRow[], ids: readonly string[]): EvalSplitScore => {
    const wanted = new Set(ids);
    const picked = rows.filter((row) => wanted.has(row.id));
    return { passed: picked.filter((row) => row.passed).length, total: picked.length };
  };
  return {
    baselineHeldOut: scoreFor(baseline, split.heldOutIds),
    candidateHeldOut: scoreFor(candidate, split.heldOutIds),
    baselineTrain: scoreFor(baseline, split.trainIds),
    candidateTrain: scoreFor(candidate, split.trainIds),
  };
}

/** The persisted, append-only decision record. */
export interface RatchetDecisionRecord {
  schemaVersion: 1;
  round: number;
  variantId: string;
  decidedAt: string;
  /** Binds the decision to the frozen split that produced the metrics. */
  splitHash: string;
  /** `casesContentHash` of the approved case set (when supplied by the caller). */
  approvalHash?: string;
  verdict: RatchetVerdict;
  reason: string;
  tieBreak: boolean;
  baselineHeldOut: EvalSplitScore;
  candidateHeldOut: EvalSplitScore;
  baselineTrain?: EvalSplitScore;
  candidateTrain?: EvalSplitScore;
  /** sha256 of canonical JSON of every field above (integrity, no engine clock). */
  recordHash: string;
}

export interface BuildRatchetDecisionInput {
  round: number;
  variantId: string;
  split: EvalFrozenSplitV1;
  metrics: RatchetRoundMetrics;
  rule?: RatchetTieBreakRule;
  approvalHash?: string;
}

export interface RatchetClock {
  now?: () => string;
}

function ratchetRecordHash(record: Omit<RatchetDecisionRecord, "recordHash">): string {
  return sha256Hex(canonicalJson(record));
}

/** Build a decision record: validate the split + metrics, decide, hash. */
export function buildRatchetDecisionRecord(
  input: BuildRatchetDecisionInput,
  clock: RatchetClock = {},
): RatchetDecisionRecord {
  const expected = frozenSplitHash(input.split?.trainIds ?? [], input.split?.heldOutIds ?? []);
  if (input.split?.splitHash !== expected) {
    throw new RatchetError("split-mismatch", `frozen split corrupt (splitHash ${String(input.split?.splitHash)} ≠ ${expected})`);
  }
  const decision = decideRatchetRound(input.metrics, input.rule);
  if (!Number.isInteger(input.round) || input.round < 0) {
    throw new RatchetError("invalid-record", `round must be a non-negative integer (got ${input.round})`);
  }
  if (typeof input.variantId !== "string" || input.variantId.trim() === "") {
    throw new RatchetError("invalid-record", "variantId must be a non-empty string");
  }
  const record: Omit<RatchetDecisionRecord, "recordHash"> = {
    schemaVersion: 1,
    round: input.round,
    variantId: input.variantId,
    decidedAt: typeof clock.now === "function" ? clock.now() : new Date().toISOString(),
    splitHash: input.split.splitHash,
    ...(input.approvalHash !== undefined ? { approvalHash: input.approvalHash } : {}),
    verdict: decision.verdict,
    reason: decision.reason,
    tieBreak: decision.tieBreak,
    baselineHeldOut: input.metrics.baselineHeldOut,
    candidateHeldOut: input.metrics.candidateHeldOut,
    ...(input.metrics.baselineTrain !== undefined ? { baselineTrain: input.metrics.baselineTrain } : {}),
    ...(input.metrics.candidateTrain !== undefined ? { candidateTrain: input.metrics.candidateTrain } : {}),
  };
  return { ...record, recordHash: ratchetRecordHash(record) };
}

function isSplitScore(value: unknown): value is EvalSplitScore {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<EvalSplitScore>;
  return Number.isInteger(row.passed) && Number.isInteger(row.total);
}

/** Parse + integrity-check one decision line. Never silently skips a bad row. */
export function parseRatchetDecisionRecord(text: string, file: string): RatchetDecisionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RatchetError(
      "corrupt-log",
      `${file}: decision line is not JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const row = parsed as Partial<RatchetDecisionRecord>;
  if (row === null || typeof row !== "object" || Array.isArray(row) || row.schemaVersion !== 1) {
    throw new RatchetError("corrupt-log", `${file}: decision line is not a v1 record`);
  }
  if (!Number.isInteger(row.round) || typeof row.variantId !== "string" || typeof row.decidedAt !== "string") {
    throw new RatchetError("corrupt-log", `${file}: decision record has an invalid round/variantId/decidedAt`);
  }
  if (typeof row.splitHash !== "string" || !/^[0-9a-f]{64}$/.test(row.splitHash)) {
    throw new RatchetError("corrupt-log", `${file}: decision record splitHash is not a sha256 digest`);
  }
  if (row.verdict !== "keep" && row.verdict !== "revert") {
    throw new RatchetError("corrupt-log", `${file}: decision record verdict must be keep|revert`);
  }
  if (typeof row.reason !== "string" || typeof row.tieBreak !== "boolean") {
    throw new RatchetError("corrupt-log", `${file}: decision record reason/tieBreak are required`);
  }
  if (!isSplitScore(row.baselineHeldOut) || !isSplitScore(row.candidateHeldOut)) {
    throw new RatchetError("corrupt-log", `${file}: decision record held-out scores are invalid`);
  }
  const { recordHash, ...rest } = row as RatchetDecisionRecord;
  if (typeof recordHash !== "string" || recordHash !== ratchetRecordHash(rest)) {
    throw new RatchetError("corrupt-log", `${file}: decision record hash mismatch (tampered record)`);
  }
  return row as RatchetDecisionRecord;
}

export interface RatchetDecisionLog {
  path: string;
  missing: boolean;
  records: RatchetDecisionRecord[];
}

/** Read the append-only log. A missing file is healthy; unreadable/corrupt is a refusal. */
export function loadRatchetDecisions(logPath: string): RatchetDecisionLog {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { path: logPath, missing: true, records: [] };
    }
    throw new RatchetError("corrupt-log", `decision log is unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  const records: RatchetDecisionRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    records.push(parseRatchetDecisionRecord(trimmed, logPath));
  }
  return { path: logPath, missing: false, records };
}

export interface AppendRatchetDecisionResult {
  path: string;
  appended: boolean;
  /** Set when the write was a no-op (identical record already present). */
  note?: string;
}

/**
 * Append a decision to the log. The file is only ever appended to, never
 * rewritten. A KEPT result for the same (round, variantId) is single-assignment:
 * any further decision for that key REFUSES (never silently overwritten).
 * An identical record is an idempotent no-op; a prior `revert` may be re-decided.
 */
export function appendRatchetDecision(logPath: string, record: RatchetDecisionRecord): AppendRatchetDecisionResult {
  // Re-validate before touching disk (callers may hand us a hand-built record).
  parseRatchetDecisionRecord(JSON.stringify(record), logPath);
  const log = loadRatchetDecisions(logPath);
  const prior = log.records.find((r) => r.round === record.round && r.variantId === record.variantId);
  if (prior !== undefined) {
    // Identical replay is an idempotent no-op (even for a kept result).
    if (prior.recordHash === record.recordHash) {
      return { path: logPath, appended: false, note: "identical decision already recorded" };
    }
    // Any DIFFERENT decision for a kept key is refused: never overwrite a keep.
    if (prior.verdict === "keep") {
      throw new RatchetError(
        "kept-result-overwrite",
        `round ${record.round} variant ${record.variantId} already kept (recordHash ${prior.recordHash}); refusing to overwrite a kept result`,
      );
    }
  }
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${canonicalJson(record)}\n`, "utf8");
  return { path: logPath, appended: true };
}

/** Verify every persisted decision was made on the given frozen split. */
export function assertRatchetDecisionsOnSplit(logPath: string, split: EvalFrozenSplitV1): void {
  const expected = frozenSplitHash(split.trainIds, split.heldOutIds);
  if (split.splitHash !== expected) {
    throw new RatchetError("split-mismatch", `frozen split corrupt (splitHash ${split.splitHash} ≠ ${expected})`);
  }
  for (const record of loadRatchetDecisions(logPath).records) {
    if (record.splitHash !== expected) {
      throw new RatchetError(
        "split-mismatch",
        `round ${record.round} variant ${record.variantId} was decided on split ${record.splitHash}, not ${expected}`,
      );
    }
  }
}

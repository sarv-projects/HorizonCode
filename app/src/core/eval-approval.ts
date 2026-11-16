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
 * frozen held-out id (omp: traces are train-only). Full keep/revert rounds
 * remain out of scope for this module.
 */

import { readFileSync } from "node:fs";
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

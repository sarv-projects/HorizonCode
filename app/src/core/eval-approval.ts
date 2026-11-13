/**
 * eval-approval.ts — eval hillclimb approval freshness (docs/30 G-8 reduced).
 *
 * A human (or CI) records approval of a case set in a small JSON file. Before a
 * run, the runner checks that the on-disk cases still match `casesContentHash`.
 * Frozen split / held-out-leakage gates are out of scope for this slice.
 */

import { readFileSync } from "node:fs";
import { canonicalJson, sha256Hex } from "../contracts";
import type { PostmortemEvalCase } from "./evals";

export interface EvalApprovalV1 {
  version: 1;
  casesContentHash: string;
  approvedAt: string;
  note?: string;
}

/** Stable digest over case ids and tasks (ignores assertions ordering noise). */
export function casesContentHash(cases: readonly PostmortemEvalCase[]): string {
  const rows = cases
    .map((c) => ({ id: c.id, task: c.task }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(canonicalJson(rows));
}

export function buildEvalApproval(cases: readonly PostmortemEvalCase[], note?: string): EvalApprovalV1 {
  return {
    version: 1,
    casesContentHash: casesContentHash(cases),
    approvedAt: new Date().toISOString(),
    ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
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
  return {
    version: 1,
    casesContentHash: row.casesContentHash,
    approvedAt: row.approvedAt,
    note: typeof row.note === "string" ? row.note : undefined,
  };
}

/** Refuses when the approval file does not match the current case set. */
export function assertEvalApprovalFresh(cases: readonly PostmortemEvalCase[], approvalPath: string): void {
  const text = readFileSync(approvalPath, "utf8");
  const approval = parseEvalApproval(text, approvalPath);
  const current = casesContentHash(cases);
  if (current !== approval.casesContentHash) {
    throw new Error(
      `${approvalPath}: approval stale (casesContentHash ${approval.casesContentHash} ≠ current ${current}) — re-approve before hillclimb`,
    );
  }
}

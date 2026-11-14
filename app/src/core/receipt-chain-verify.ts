/**
 * Read-only workspace receipt chain verify (R172 reduced; ruling **289**).
 *
 * Mirrors `LocalKernel.verifyReceipts` hash chain recompute (sidecar strip per **272**).
 * Anchor check reduced (**294**): `.head` when present via `verifyReceiptAnchorSync`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Receipt } from "../contracts";
import { hashReceiptVersioned } from "./receipt-schema";
import { type ChainAnchorVerdict, checkChainAnchorSync, readHeadSync, verifyReceiptAnchorSync } from "./chain-anchor-verify";
import { receiptsPath } from "./session-kernel-reconcile";

export interface ReceiptChainVerifyVerdict {
  ok: boolean;
  count: number;
  brokenAt?: number;
  refusal?: string;
  anchor?: ChainAnchorVerdict;
}

export function verifyReceiptChainSync(workspace: string): ReceiptChainVerifyVerdict {
  const file = receiptsPath(workspace);
  if (!existsSync(file)) {
    return { ok: true, count: 0 };
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, count: 0, refusal: err instanceof Error ? err.message : String(err) };
  }

  let count = 0;
  let prevHash: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const expected = count + 1;
    let receipt: Receipt;
    try {
      receipt = JSON.parse(trimmed) as Receipt;
    } catch {
      return { ok: false, count, brokenAt: expected };
    }
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      typeof receipt.seq !== "number" ||
      typeof receipt.hash !== "string"
    ) {
      return { ok: false, count, brokenAt: expected };
    }
    if (receipt.seq !== expected) {
      return { ok: false, count, brokenAt: receipt.seq > 0 ? receipt.seq : expected };
    }
    if (receipt.prevHash !== prevHash) return { ok: false, count, brokenAt: receipt.seq };
    let computed: string;
    try {
      computed = hashReceiptVersioned(receipt as unknown as Record<string, unknown>);
    } catch {
      return { ok: false, count, brokenAt: receipt.seq };
    }
    if (computed !== receipt.hash) return { ok: false, count, brokenAt: receipt.seq };
    prevHash = receipt.hash;
    count = expected;
  }
  const anchor = verifyReceiptAnchorSync(workspace);
  const ok = anchor.ok;
  return { ok, count: anchor.count, brokenAt: anchor.brokenAt, refusal: anchor.refusal, anchor };
}

/** A single verified snapshot prevents child receipt links from being
 * attributed to bytes read *after* a separate chain validation. The hash walk
 * and receipt index now consume the same immutable string snapshot. No
 * cross-process filesystem lock is claimed; keyed anchors remain opt-in. */
export interface VerifiedReceiptSnapshot {
  ok: boolean;
  receipts: readonly Receipt[];
  count: number;
  brokenAt?: number;
  refusal?: string;
  anchorAbsent?: boolean;
}

export function readVerifiedReceiptSnapshotSync(workspace: string): VerifiedReceiptSnapshot {
  const file = receiptsPath(workspace);
  if (!existsSync(file)) return { ok: true, receipts: [], count: 0 };
  let bytes: string;
  try {
    bytes = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, receipts: [], count: 0, refusal: String(error) };
  }
  const records: Receipt[] = [];
  let prevHash: string | null = null;
  for (const line of bytes.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const expected = records.length + 1;
    let row: Receipt;
    try {
      row = JSON.parse(trimmed) as Receipt;
    } catch {
      return { ok: false, receipts: [], count: records.length, brokenAt: expected };
    }
    if (!row || typeof row !== "object" || typeof row.hash !== "string" ||
        row.seq !== expected || row.prevHash !== prevHash) {
      return { ok: false, receipts: [], count: records.length, brokenAt: expected };
    }
    let computed: string;
    try {
      computed = hashReceiptVersioned(row as unknown as Record<string, unknown>);
    } catch {
      return { ok: false, receipts: [], count: records.length, brokenAt: expected };
    }
    if (computed !== row.hash) {
      return { ok: false, receipts: [], count: records.length, brokenAt: expected };
    }
    records.push(row);
    prevHash = row.hash;
  }
  const anchor = checkChainAnchorSync({
    head: readHeadSync(file),
    count: records.length,
    last: records.length ? {
      hash: records[records.length - 1]!.hash,
      record: records[records.length - 1]! as unknown as Record<string, unknown>,
    } : undefined,
    kind: "receipt",
    label: "receipts.jsonl",
  });
  if (!anchor.ok) {
    return { ok: false, receipts: [], count: records.length,
      brokenAt: anchor.brokenAt, refusal: anchor.refusal };
  }
  return { ok: true, receipts: records, count: records.length, anchorAbsent: anchor.anchorAbsent };
}

/** One-line + detail lines for `hzcode session verify` (ruling **291**). */
export function formatReceiptChainVerifySummary(verdict: ReceiptChainVerifyVerdict): string[] {
  if (verdict.refusal) {
    return ["receipt chain: refused", `  ${verdict.refusal}`];
  }
  if (verdict.ok) {
    const lines = [`receipt chain: ok (${verdict.count} receipt(s))`];
    if (verdict.anchor?.anchorAbsent && verdict.count > 0) {
      lines.push("  anchor: legacy (no .head)");
    } else if (verdict.anchor && !verdict.anchor.skipped) {
      lines.push("  anchor: ok");
    }
    return lines;
  }
  const lines = [
    "receipt chain: broken",
    `  brokenAt seq ${verdict.brokenAt ?? "?"}`,
    `  verified prefix count ${verdict.count}`,
  ];
  if (verdict.anchor?.refusal) lines.push(`  anchor: ${verdict.anchor.refusal}`);
  return lines;
}

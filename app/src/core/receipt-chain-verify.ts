/**
 * Read-only workspace receipt chain verify (R172 reduced; ruling **289**).
 *
 * Mirrors `LocalKernel.verifyReceipts` hash chain recompute (sidecar strip per **272**).
 * Anchor check reduced (**294**): `.head` when present via `verifyReceiptAnchorSync`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Receipt } from "../contracts";
import { hashReceipt } from "../contracts";
import { type ChainAnchorVerdict, verifyReceiptAnchorSync } from "./chain-anchor-verify";
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
    const {
      hash,
      effectId: _e,
      postimageDigest: _pd,
      postimagePath: _pp,
      childEffectIds: _c,
      ...rest
    } = receipt as Receipt & {
      effectId?: string;
      postimageDigest?: string;
      postimagePath?: string;
      childEffectIds?: string[];
    };
    if (hashReceipt(rest) !== hash) return { ok: false, count, brokenAt: receipt.seq };
    prevHash = hash;
    count = expected;
  }
  const anchor = verifyReceiptAnchorSync(workspace);
  const ok = anchor.ok;
  return { ok, count: anchor.count, brokenAt: anchor.brokenAt, refusal: anchor.refusal, anchor };
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

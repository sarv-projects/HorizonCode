/**
 * R172 — kernel-held receipt issuer stamp verify (read-only).
 *
 * Stamps are minted only inside Rust `receipt.issue` when `.receipt-issuer.key`
 * exists. Ambient Bun cannot forge without reading that file.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Receipt } from "../contracts";
import { kernelStateDir } from "./paths";

export const RECEIPT_ISSUER_KEY_FILE = ".receipt-issuer.key";

export function loadReceiptIssuerKeyFromStateDirSync(stateDir: string): Buffer | undefined {
  const file = `${stateDir}/${RECEIPT_ISSUER_KEY_FILE}`;
  if (!existsSync(file)) return undefined;
  try {
    const hex = readFileSync(file, "utf8").trim();
    if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
    return Buffer.from(hex, "hex");
  } catch {
    return undefined;
  }
}

export function loadReceiptIssuerKeySync(workspace: string): Buffer | undefined {
  return loadReceiptIssuerKeyFromStateDirSync(kernelStateDir(workspace));
}

export function receiptsDeclareNestedParentLink(receipts: readonly Receipt[]): boolean {
  return receipts.some(
    (r) => typeof r.parentReceiptId === "string" && r.parentReceiptId.trim() !== "",
  );
}

export function issuerStampForHash(key: Buffer, receiptHash: string): string {
  return createHmac("sha256", key).update(receiptHash, "utf8").digest("hex");
}

export function verifyReceiptIssuerStamp(receipt: Receipt, key: Buffer): boolean {
  const stamp = receipt.issuerStamp;
  if (stamp === undefined || stamp.length !== 64) return false;
  const expected = issuerStampForHash(key, receipt.hash);
  try {
    return timingSafeEqual(Buffer.from(stamp, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export type IssuerAttestationFail = {
  ok: false;
  reason: string;
  receiptId?: string;
  seq?: number;
};

export type IssuerAttestationResult = { ok: true } | IssuerAttestationFail;

export type IssuerKeyLocator =
  | { workspace: string; stateDir?: undefined }
  | { stateDir: string; workspace?: undefined };

function resolveIssuerKey(loc: IssuerKeyLocator): Buffer | undefined {
  if (loc.stateDir !== undefined) return loadReceiptIssuerKeyFromStateDirSync(loc.stateDir);
  return loadReceiptIssuerKeySync(loc.workspace);
}

/**
 * Keyed cross-process attestation (ruling **725**): when receipts declare
 * `parentReceiptId`, Bun verifies `issuerStamp` against the kernel-persisted
 * `.receipt-issuer.key` (same material Rust `receipt.verify` uses). Without
 * that key, nested-link claims are refused — not silently trusted.
 */
export function verifyParentReceiptIssuerStamps(
  receipts: readonly Receipt[],
  loc: IssuerKeyLocator,
): IssuerAttestationResult {
  const nested = receiptsDeclareNestedParentLink(receipts);
  if (!nested) return { ok: true };
  const key = resolveIssuerKey(loc);
  if (key === undefined) {
    return {
      ok: false,
      reason:
        "parentReceiptId present but .receipt-issuer.key absent — keyed nested attestation unavailable",
    };
  }
  for (const receipt of receipts) {
    const parentId = receipt.parentReceiptId;
    if (parentId === undefined || parentId === "") continue;
    if (!verifyReceiptIssuerStamp(receipt, key)) {
      return {
        ok: false,
        reason: `issuerStamp missing or invalid for nested receipt ${receipt.id} (parent ${parentId})`,
        receiptId: receipt.id,
        seq: receipt.seq,
      };
    }
  }
  return { ok: true };
}
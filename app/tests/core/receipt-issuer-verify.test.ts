/**
 * Ruling 688 — kernel issuer stamp on nested parentReceiptId receipts.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Receipt } from "../../src/contracts";
import {
  issuerStampForHash,
  loadReceiptIssuerKeySync,
  RECEIPT_ISSUER_KEY_FILE,
  verifyParentReceiptIssuerStamps,
  verifyReceiptIssuerStamp,
} from "../../src/core/receipt-issuer-verify";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import { kernelStateDir } from "../../src/core/paths";

const TEST_KEY = Buffer.alloc(32, 0x42);

function baseReceipt(partial: Partial<Receipt>): Receipt {
  const body = {
    id: "rcp_c",
    seq: 2,
    ts: "2026-11-19T00:00:00Z",
    action: "tool.execute",
    tool: "agent",
    argsDigest: "a",
    resultDigest: "b",
    prevHash: "aa".repeat(32),
    schemaVersion: 2 as const,
    effectId: "child-fx",
    parentReceiptId: "rcp_p",
    ...partial,
  };
  const hash = hashReceiptVersioned(body as unknown as Record<string, unknown>);
  return { ...body, hash };
}

describe("receipt issuer stamp (ruling 688)", () => {
  test("stamp verifies over receipt hash", () => {
    const receipt = baseReceipt({});
    const stamp = issuerStampForHash(TEST_KEY, receipt.hash);
    expect(verifyReceiptIssuerStamp({ ...receipt, issuerStamp: stamp }, TEST_KEY)).toBe(true);
    expect(verifyReceiptIssuerStamp({ ...receipt, issuerStamp: "f".repeat(64) }, TEST_KEY)).toBe(false);
  });

  test("parentReceiptId child requires stamp when key file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "hz-issuer-verify-"));
    try {
      const kdir = kernelStateDir(root);
      mkdirSync(kdir, { recursive: true });
      writeFileSync(join(kdir, RECEIPT_ISSUER_KEY_FILE), TEST_KEY.toString("hex"), { mode: 0o600 });
      expect(loadReceiptIssuerKeySync(root)?.equals(TEST_KEY)).toBe(true);

      const unstamped = baseReceipt({});
      expect(verifyParentReceiptIssuerStamps([unstamped], { workspace: root }).ok).toBe(false);

      const stamped = {
        ...unstamped,
        issuerStamp: issuerStampForHash(TEST_KEY, unstamped.hash),
      };
      expect(verifyParentReceiptIssuerStamps([stamped], { workspace: root }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no key file refuses parentReceiptId attestation claims", () => {
    const root = mkdtempSync(join(tmpdir(), "hz-issuer-skip-"));
    try {
      const child = baseReceipt({ issuerStamp: undefined });
      const verdict = verifyParentReceiptIssuerStamps([child], { workspace: root });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) {
        expect(verdict.reason).toMatch(/issuer\.key absent/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no parentReceiptId skips attestation when key absent", () => {
    const root = mkdtempSync(join(tmpdir(), "hz-issuer-root-"));
    try {
      const plain = baseReceipt({ parentReceiptId: undefined });
      expect(verifyParentReceiptIssuerStamps([plain], { workspace: root }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
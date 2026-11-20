import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { verifyReceiptChainSync } from "../../src/core/receipt-chain-verify";
import {
  issuerStampForHash,
  RECEIPT_ISSUER_KEY_FILE,
} from "../../src/core/receipt-issuer-verify";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import { kernelStateDir } from "../../src/core/paths";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

const TEST_KEY = Buffer.alloc(32, 0x22);

describe("receipt-chain-verify (ruling 289)", () => {
  test("ok chain with sidecar fields strips before recompute", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rcpt-verify-"));
    try {
      const base0 = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null,
        action: "tool.execute" as const,
        tool: "read",
        argsDigest: "a",
        resultDigest: "b",
      };
      const r1 = { ...base0, hash: hashReceipt(base0), effectId: "eff-1", postimageDigest: "d".repeat(64) };
      const base1 = {
        id: "r2",
        seq: 2,
        ts: "2026-01-01T00:00:01.000Z",
        prevHash: r1.hash,
        action: "tool.execute" as const,
        tool: "write",
        argsDigest: "c",
        resultDigest: "d",
      };
      const r2 = { ...base1, hash: hashReceipt(base1) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
      const v = verifyReceiptChainSync(ws);
      expect(v.ok).toBe(true);
      expect(v.count).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("parentReceiptId without issuer key refuses chain verify", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rcpt-issuer-refuse-"));
    try {
      const body = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null,
        action: "tool.execute" as const,
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        schemaVersion: 2 as const,
        effectId: "child-fx",
        parentReceiptId: "rcp_parent",
      };
      const hash = hashReceiptVersioned(body as unknown as Record<string, unknown>);
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ ...body, hash })}\n`);
      const v = verifyReceiptChainSync(ws);
      expect(v.ok).toBe(false);
      expect(v.refusal).toMatch(/issuer attestation/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("parentReceiptId with valid stamp verifies", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rcpt-issuer-ok-"));
    try {
      const kdir = kernelStateDir(ws);
      mkdirSync(kdir, { recursive: true });
      writeFileSync(path.join(kdir, RECEIPT_ISSUER_KEY_FILE), TEST_KEY.toString("hex"), { mode: 0o600 });
      const body = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null,
        action: "tool.execute" as const,
        tool: "agent",
        argsDigest: "a",
        resultDigest: "b",
        schemaVersion: 2 as const,
        effectId: "child-fx",
        parentReceiptId: "rcp_parent",
      };
      const hash = hashReceiptVersioned(body as unknown as Record<string, unknown>);
      const row = { ...body, hash, issuerStamp: issuerStampForHash(TEST_KEY, hash) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(row)}\n`);
      const v = verifyReceiptChainSync(ws);
      expect(v.ok).toBe(true);
      expect(v.count).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("broken prevHash fails at seq", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rcpt-broken-"));
    try {
      const base = {
        id: "r1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: "wrong",
        action: "tool.execute" as const,
        tool: "read",
        argsDigest: "a",
        resultDigest: "b",
      };
      const r1 = { ...base, hash: hashReceipt({ ...base, prevHash: null }) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(r1)}\n`);
      const v = verifyReceiptChainSync(ws);
      expect(v.ok).toBe(false);
      expect(v.brokenAt).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

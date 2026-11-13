import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { verifyReceiptChainSync } from "../../src/core/receipt-chain-verify";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

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

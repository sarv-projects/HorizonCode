/** Receipt v2 cross-language sidecar integrity; legacy v1 stays byte-identical. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalJson, hashReceipt, sha256Hex } from "../../src/contracts";
import { KernelClient, LocalKernel } from "../../src/core/kernel";
import { hashReceiptVersioned, receiptPreimageVersioned } from "../../src/core/receipt-schema";
import { verifyReceiptChainSync } from "../../src/core/receipt-chain-verify";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";
import { hasRustKernel, rustKernelPath } from "./helpers";

const digest = (s: string) => sha256Hex(s);

describe("receipt v2 authenticated sidecars (ruling 361)", () => {
  test("frozen v1 hash is unchanged and historical unbound sidecars are not falsely authenticated", () => {
    const base = {
      id: "v1", seq: 1, ts: "2026-11-14T00:00:00.000Z", prevHash: null,
      action: "tool.execute", tool: "read", argsDigest: digest("args"), resultDigest: digest("output"),
    };
    expect(hashReceiptVersioned(base)).toBe(hashReceipt(base));
    const legacy = { ...base, effectId: "unbound-effect", postimageDigest: digest("after") };
    expect(hashReceiptVersioned(legacy)).toBe(hashReceipt(base));
    const modern = { ...legacy, schemaVersion: 2 };
    expect(hashReceiptVersioned(modern)).not.toBe(hashReceipt(base));
    expect(receiptPreimageVersioned(modern)).toMatchObject({
      schemaVersion: 2, effectId: "unbound-effect", postimageDigest: digest("after"),
    });
    expect(() => hashReceiptVersioned({ ...modern, schemaVersion: 3 }))
      .toThrow("unsupported receipt schema");
  });

  test("LocalKernel creates and verifies a mixed v1/v2 chain; sidecar forgery breaks v2", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-receipt-v2-"));
    const state = path.join(ws, ".hz", "state", "kernel");
    const local = new LocalKernel({ stateDir: state });
    const file = receiptsPath(ws);
    try {
      const legacy = await local.issueReceipt({
        action: "tool.execute", tool: "read", argsDigest: digest("read"), resultDigest: digest("result"),
      });
      expect(legacy.schemaVersion).toBeUndefined();
      expect(legacy.hash).toBe(hashReceipt({
        id: legacy.id, seq: legacy.seq, ts: legacy.ts, prevHash: legacy.prevHash,
        action: legacy.action, tool: legacy.tool, argsDigest: legacy.argsDigest,
        resultDigest: legacy.resultDigest,
      }));
      expect((await local.verifyReceipts()).ok).toBe(true);
      const v2 = await local.issueReceipt({
        action: "tool.execute", tool: "agent", argsDigest: digest("agent"), resultDigest: digest("report"),
        effectId: "effect-7", postimagePath: path.join(ws, "artifact"),
        postimageDigest: digest("artifact"), childEffectIds: ["child-1", "child-2"],
      });
      expect(v2.schemaVersion).toBe(2);
      expect(v2.childEffectIds).toEqual(["child-1", "child-2"]);
      expect(v2.hash).toBe(hashReceiptVersioned(v2));
      const verifyLocal = await local.verifyReceipts();
      const verifyReadOnly = verifyReceiptChainSync(ws);
      expect(verifyLocal.ok).toBe(true);
      expect(verifyReadOnly.ok).toBe(true);

      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.replace('"effectId":"effect-7"', '"effectId":"forged-effect"'));
      expect((await local.verifyReceipts()).ok).toBe(false);
      expect(verifyReceiptChainSync(ws).ok).toBe(false);
      writeFileSync(file, original.replace('"child-1"', '"forged-child"'));
      expect((await local.verifyReceipts()).ok).toBe(false);
      expect(verifyReceiptChainSync(ws).ok).toBe(false);
    } finally {
      await local.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("v2 refuses duplicate children and unknown fields before issuing", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "hz-receipt-v2-invalid-"));
    const local = new LocalKernel({ stateDir: state });
    try {
      await expect(local.issueReceipt({
        action: "tool.execute", tool: "agent", argsDigest: digest("a"),
        resultDigest: digest("b"), effectId: "parent",
        childEffectIds: ["same", "same"],
      })).rejects.toThrow("childEffectIds");
      expect(() => hashReceiptVersioned({
        schemaVersion: 2, id: "r", seq: 1, ts: "x", prevHash: null,
        action: "tool.execute", tool: "agent", argsDigest: digest("a"),
        resultDigest: digest("b"), effectId: "parent", untrackedProof: true,
      })).toThrow("unexpected receipt v2 field");
    } finally {
      await local.close();
      rmSync(state, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasRustKernel)("trusted Rust receipt.issue with sidecars is independently verified by TypeScript", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-receipt-rust-v2-"));
    const state = path.join(ws, ".hz", "state", "kernel");
    const prior = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = rustKernelPath;
    const client = new KernelClient({ workspace: ws, stateDir: state });
    try {
      expect(await client.start()).toBe("trusted");
      const r1 = await client.issueReceipt({
        action: "tool.execute", tool: "read", argsDigest: digest("legacy"),
        resultDigest: digest("legacy-output"),
      });
      expect(r1.schemaVersion).toBeUndefined();
      const r2 = await client.issueReceipt({
        action: "tool.execute", tool: "agent", argsDigest: digest("modern"),
        resultDigest: digest("modern-output"), effectId: "rust-parent",
        childEffectIds: ["rust-child"], postimageDigest: digest("after"),
      });
      expect(r2.schemaVersion).toBe(2);
      expect(r2.hash).toBe(hashReceiptVersioned(r2));
      expect(verifyReceiptChainSync(ws).ok).toBe(true);
      const file = receiptsPath(ws);
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.replace("rust-child", "forged-child"));
      expect(verifyReceiptChainSync(ws).ok).toBe(false);
    } finally {
      await client.close();
      if (prior === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prior;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

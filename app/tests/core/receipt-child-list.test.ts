import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { hashReceiptVersioned } from "../../src/core/receipt-schema";
import { EffectHost } from "../../src/core/effect-host";
import { mergedChildEffectIds, resolveChildReceiptLinks } from "../../src/core/receipt-child-list";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

describe("receipt-child-list (ruling 294)", () => {
  test("merged ids from record execute step and receipt sidecar", () => {
    const host = new EffectHost();
    const parent = "00000000-0000-4000-8000-0000000000aa";
    const child = "00000000-0000-4000-8000-0000000000bb";
    host.begin(parent, "agent", "c1");
    host.recordExecute(parent, { ok: true, childEffectIds: [child] });
    const receipt = {
      id: "r-parent",
      seq: 1,
      ts: "2026-01-01T00:00:00.000Z",
      prevHash: null as string | null,
      hash: "h",
      action: "tool.execute",
      tool: "agent",
      argsDigest: "a",
      resultDigest: "b",
      effectId: parent,
      childEffectIds: [child],
    };
    expect(mergedChildEffectIds(host.getRecord(parent), receipt)).toEqual([child]);
  });

  test("resolveChildReceiptLinks maps workspace receipts", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-rcpt-"));
    try {
      const child = "child-eff-1";
      const base = {
        id: "r-child",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null,
        action: "tool.execute" as const,
        tool: "grep",
        argsDigest: "a",
        resultDigest: "b",
        effectId: child,
        schemaVersion: 2 as const,
      };
      const row = { ...base, hash: hashReceiptVersioned(base) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(row)}\n`);
      const links = resolveChildReceiptLinks(ws, [child], "agent");
      expect(links).toHaveLength(1);
      expect(links[0]?.receiptId).toBe("r-child");
      expect(links[0]?.tool).toBe("grep");
      expect(links[0]?.parentTool).toBe("agent");
      expect(links[0]?.chainEvidence).toBe("hash_walk_unanchored");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("legacy v1 effectId sidecar remains explicitly unbound despite valid hash and head", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-unbound-v1-"));
    try {
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      const base = {
        id: "old-v1", seq: 1, ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null, action: "tool.execute",
        tool: "read", argsDigest: "a", resultDigest: "b",
      };
      const row = { ...base, hash: hashReceipt(base), effectId: "claimed-child" };
      writeFileSync(file, JSON.stringify(row) + "\n");
      writeFileSync(file + ".head", JSON.stringify({ seq: 1, hash: row.hash }));
      const link = resolveChildReceiptLinks(ws, ["claimed-child"])[0];
      expect(link?.chainEvidence).toBe("legacy_unbound_effect_id");
      expect(link?.receiptId).toBeUndefined();
      // The v1 chain still checks out after a sidecar forgery: that is why
      // the link MUST remain untrusted until a v2 receipt is issued.
      writeFileSync(file, JSON.stringify({ ...row, effectId: "forged-child" }) + "\n");
      const forged = resolveChildReceiptLinks(ws, ["forged-child"])[0];
      expect(forged?.chainEvidence).toBe("legacy_unbound_effect_id");
      expect(forged?.receiptId).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("tampered hash/anchor chain never attributes a child's forged receipt", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-rcpt-corrupt-"));
    try {
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      const seed = {
        id: "r-child", seq: 1, ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null, action: "tool.execute", tool: "read",
        argsDigest: "a", resultDigest: "b", effectId: "child-1",
        schemaVersion: 2 as const,
      };
      const row = { ...seed, hash: hashReceiptVersioned(seed) };
      writeFileSync(file, JSON.stringify(row) + "\n");
      writeFileSync(file + ".head", JSON.stringify({ seq: 1, hash: row.hash }));
      const valid = resolveChildReceiptLinks(ws, ["child-1"])[0];
      expect(valid?.chainEvidence).toBe("hash_and_anchor_valid");
      expect(valid?.receiptId).toBe("r-child");
      writeFileSync(file, JSON.stringify({ ...row, tool: "shell" }) + "\n");
      const invalid = resolveChildReceiptLinks(ws, ["child-1"])[0];
      expect(invalid?.chainEvidence).toBe("broken_chain");
      expect(invalid?.receiptId).toBeUndefined();
      expect(invalid?.receiptSeq).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("two valid chained receipts with the same effectId refuse ambiguous linkage", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-rcpt-duplicate-"));
    try {
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      const a = {
        id: "r-1", seq: 1, ts: "2026-01-01T00:00:00.000Z",
        prevHash: null as string | null, action: "tool.execute", tool: "read",
        argsDigest: "a", resultDigest: "b", effectId: "repeated-child",
      };
      const { effectId: _effectId, ...hashableA } = a;
      const first = { ...a, hash: hashReceipt(hashableA) };
      const b = { ...a, id: "r-2", seq: 2, prevHash: first.hash, tool: "write" };
      const { effectId: _effectId2, ...hashableB } = b;
      const second = { ...b, hash: hashReceipt(hashableB) };
      writeFileSync(file, [JSON.stringify(first), JSON.stringify(second)].join("\n") + "\n");
      writeFileSync(file + ".head", JSON.stringify({ seq: 2, hash: second.hash }));
      const link = resolveChildReceiptLinks(ws, ["repeated-child"])[0];
      expect(link?.chainEvidence).toBe("duplicate_effect_id");
      expect(link?.receiptId).toBeUndefined();
      expect(link?.receiptSeq).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("unknown workspace and absent child receipt are distinguishable from verified", () => {
    const unknown = resolveChildReceiptLinks(undefined, ["child-1"])[0];
    expect(unknown?.chainEvidence).toBe("workspace_unavailable");
    const ws = mkdtempSync(path.join(tmpdir(), "hz-child-rcpt-missing-"));
    try {
      const missing = resolveChildReceiptLinks(ws, ["missing"])[0];
      expect(missing?.chainEvidence).toBe("missing_receipt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
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
      };
      const row = { ...base, hash: hashReceipt(base) };
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(row)}\n`);
      const links = resolveChildReceiptLinks(ws, [child], "agent");
      expect(links).toHaveLength(1);
      expect(links[0]?.receiptId).toBe("r-child");
      expect(links[0]?.tool).toBe("grep");
      expect(links[0]?.parentTool).toBe("agent");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

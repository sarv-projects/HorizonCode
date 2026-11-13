import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashReceipt } from "../../src/contracts";
import { renderReceiptShow } from "../../src/core/receipt-cli";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

describe("receipt-cli (ruling 286)", () => {
  test("renderReceiptShow prints structured inspector panes", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rcpt-cli-"));
    try {
      const id = "rcp-show-me-0001";
      const file = receiptsPath(ws);
      mkdirSync(path.dirname(file), { recursive: true });
      const base = {
        id,
        seq: 1,
        tool: "read",
        action: "tool.execute" as const,
        ts: "2026-01-01T00:00:00.000Z",
        argsDigest: "a",
        resultDigest: "b",
        prevHash: null,
      };
      writeFileSync(file, JSON.stringify({ ...base, hash: hashReceipt(base) }) + "\n");
      const out = renderReceiptShow(ws, id);
      expect(out).toContain("Receipt inspector");
      expect(out).toContain(id);
      expect(out).toContain("── Chain verify ──");
      expect(out).toContain("status ok");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

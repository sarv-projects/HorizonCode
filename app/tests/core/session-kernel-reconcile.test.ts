import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import {
  formatUnpairedSessionKernelNotice,
  reconcileSessionKernel,
  sessionKernelReconcileNotice,
  receiptsPath,
  sessionEventsPath,
} from "../../src/core/session-kernel-reconcile";

describe("session↔kernel reconcile", () => {
  test("pairs tool.call with same-tool receipt", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rec-"));
    try {
      const sid = "sess1";
      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          id: "e1",
          seq: 1,
          type: EventTypes.toolCall,
          payload: { id: "c1", name: "write" },
        }) + "\n",
      );
      const rFile = receiptsPath(ws);
      mkdirSync(path.dirname(rFile), { recursive: true });
      writeFileSync(
        rFile,
        JSON.stringify({ id: "r1", seq: 1, tool: "write", action: "tool.execute" }) + "\n",
      );
      const report = reconcileSessionKernel(ws, sid);
      expect(report.toolCalls).toBe(1);
      expect(report.receipts).toBe(1);
      expect(report.paired).toBe(1);
      expect(report.unpairedCalls).toEqual([]);
      expect(report.unpairedReceipts).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("prefers effectId pairing over tool name", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rec-eff-"));
    try {
      const sid = "sess-eff";
      const effectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          id: "e1",
          seq: 1,
          type: EventTypes.toolCall,
          payload: { id: "c1", name: "read", effectId },
        }) + "\n",
      );
      const rFile = receiptsPath(ws);
      mkdirSync(path.dirname(rFile), { recursive: true });
      writeFileSync(
        rFile,
        JSON.stringify({ id: "r1", seq: 1, tool: "other", effectId, action: "tool.execute" }) + "\n",
      );
      const report = reconcileSessionKernel(ws, sid);
      expect(report.paired).toBe(1);
      expect(report.effectIdPaired).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("notice formatter names unpaired sides", () => {
    const msg = formatUnpairedSessionKernelNotice({
      sessionStream: "session:x",
      toolCalls: 1,
      receipts: 0,
      paired: 0,
      effectIdPaired: 0,
      unpairedCalls: [{ callId: "c1", tool: "edit", seq: 1 }],
      unpairedReceipts: [],
    });
    expect(msg).toContain("unpaired");
    expect(msg).toContain("edit");
    expect(sessionKernelReconcileNotice("/nope", "missing")).toBeUndefined();
  });

  test("reports unpaired call when no receipt", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rec2-"));
    try {
      const sid = "sess2";
      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          id: "e1",
          seq: 1,
          type: EventTypes.toolCall,
          payload: { id: "c9", name: "edit" },
        }) + "\n",
      );
      const report = reconcileSessionKernel(ws, sid);
      expect(report.paired).toBe(0);
      expect(report.unpairedCalls).toHaveLength(1);
      expect(report.unpairedCalls[0]?.tool).toBe("edit");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

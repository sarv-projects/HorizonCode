import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { EffectHost } from "../../src/core/effect-host";
import { WorkspaceEffectLedger, loadEffectLedger } from "../../src/core/effect-ledger";
import { reconcileEffectsOnAttach } from "../../src/core/effect-reconcile-attach";
import { receiptsPath, sessionEventsPath } from "../../src/core/session-kernel-reconcile";

describe("effect reconcile on attach", () => {
  test("unknown durable row settles from session receipt.issued", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-att-"));
    const sid = "s-attach";
    const effectId = "11111111-1111-4111-8111-111111111111";
    try {
      const ledger = new WorkspaceEffectLedger(ws);
      const host = new EffectHost(ledger);
      host.begin(effectId, "read", "call-a");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true });
      host.persistRecord(effectId, "unknown");
      host.replaceRecord({
        effectId,
        tool: "read",
        callId: "call-a",
        steps: host.getRecord(effectId)!.steps,
      });

      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        [
          JSON.stringify({
            type: EventTypes.receiptIssued,
            payload: { effectId, receiptId: "rcp-a", seq: 9, tool: "read", callId: "call-a" },
          }),
        ].join("\n") + "\n",
      );

      const host2 = new EffectHost();
      host2.hydrate(loadEffectLedger(ws).records);
      const rows = reconcileEffectsOnAttach(ws, sid, host2);
      expect(rows.some((r) => r.reconciled && r.effectId === effectId)).toBe(true);
      expect(host2.reconcileEffect(effectId)).toBe("settled");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("receipt chain fallback when event log lacks observe", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-att2-"));
    const sid = "s-attach2";
    const effectId = "22222222-2222-4222-8222-222222222222";
    try {
      const ledger = new WorkspaceEffectLedger(ws);
      const host = new EffectHost(ledger);
      host.begin(effectId, "write", "call-b");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true });
      host.persistRecord(effectId, "unknown");

      const rFile = receiptsPath(ws);
      mkdirSync(path.dirname(rFile), { recursive: true });
      writeFileSync(
        rFile,
        JSON.stringify({
          id: "rcp-b",
          seq: 3,
          tool: "write",
          callId: "call-b",
          effectId,
          action: "tool.execute",
        }) + "\n",
      );

      const host2 = new EffectHost();
      host2.hydrate(loadEffectLedger(ws).records);
      const rows = reconcileEffectsOnAttach(ws, sid, host2);
      expect(rows.find((r) => r.effectId === effectId)?.verdict).toBe("settled");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

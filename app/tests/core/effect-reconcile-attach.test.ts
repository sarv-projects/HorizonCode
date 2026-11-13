import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { EffectHost } from "../../src/core/effect-host";
import { WorkspaceEffectLedger, loadEffectLedger } from "../../src/core/effect-ledger";
import {
  reconcileEffectsOnAttach,
  restoreObservePendingFromDurableLedger,
} from "../../src/core/effect-reconcile-attach";
import { effectReconcileBlockObservePendingRefusal } from "../../src/core/effect-reconcile-block";
import { observePendingResourceKeys } from "../../src/core/effect-resource-gate";
import { receiptsPath, sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import { setEnv, snapshotEnv, restoreEnv, type EnvSnapshot } from "./helpers";

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

  test("receipt fallback does not borrow a different effectId with a reused callId", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-foreign-"));
    const sid = "s-other-session";
    const effectId = "11a11111-1111-4111-8111-111111111111";
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      host.begin(effectId, "write", "reused-call");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true, resourceKey: path.join(ws, "target.txt") });
      host.persistRecord(effectId, "unknown");

      const receiptFile = receiptsPath(ws);
      mkdirSync(path.dirname(receiptFile), { recursive: true });
      writeFileSync(receiptFile, JSON.stringify({
        id: "receipt-for-another-effect",
        seq: 5,
        effectId: "22b22222-2222-4222-8222-222222222222",
        tool: "write",
        callId: "reused-call",
      }) + "\n");

      const restored = new EffectHost();
      const rows = reconcileEffectsOnAttach(ws, sid, restored);
      expect(rows.some((r) => r.effectId === effectId && r.verdict === "settled")).toBe(false);
      expect(restored.reconcileEffect(effectId)).toBe("unknown");
      expect(restored.getRecord(effectId)?.steps.some((s) => s.phase === "observe")).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("foreign tool.call effectId cannot backfill a recycled callId's resourceKey", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-foreign-args-"));
    const sid = "s-foreign-args";
    const effectId = "cc111111-1111-4111-8111-111111111111";
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      host.begin(effectId, "write", "reused-call");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true });
      host.persistRecord(effectId, "unknown");
      const eventFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(eventFile), { recursive: true });
      writeFileSync(eventFile, JSON.stringify({
        type: EventTypes.toolCall,
        payload: {
          effectId: "dd222222-2222-4222-8222-222222222222",
          callId: "reused-call",
          name: "write",
          args: { path: "foreign.txt", content: "x" },
        },
      }) + "\n");
      const restored = new EffectHost();
      reconcileEffectsOnAttach(ws, sid, restored);
      expect(restored.getRecord(effectId)?.steps.find((s) => s.phase === "execute")?.resourceKey).toBeUndefined();
      expect(restored.reconcileEffect(effectId)).toBe("unknown");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("reload preserves observe-pending resourceKey from durable ledger (ruling 338)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-att338a-"));
    const effectId = "33333333-3333-4333-8333-333333333333";
    const target = path.join(ws, "cross.ts");
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
    try {
      const ledger = new WorkspaceEffectLedger(ws);
      const host = new EffectHost(ledger);
      host.begin(effectId, "write", "call-338");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true, resourceKey: target });
      host.persistRecord(effectId, "unknown");

      const host2 = new EffectHost();
      host2.hydrate(loadEffectLedger(ws).records);
      restoreObservePendingFromDurableLedger(host2, ws);
      expect(observePendingResourceKeys(host2).get(path.resolve(target))).toEqual([effectId]);
      const refusal = effectReconcileBlockObservePendingRefusal(
        ws,
        "edit",
        { path: "cross.ts", old: "a", new: "b" },
        host2,
      );
      expect(refusal).toContain("observe not settled");
    } finally {
      restoreEnv(envBackup);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("attach backfills execute resourceKey from tool.call when ledger row lacks it (ruling 338)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-att338b-"));
    const sid = "s-338";
    const effectId = "44444444-4444-4444-8444-444444444444";
    const target = path.join(ws, "backfill.ts");
    try {
      const ledger = new WorkspaceEffectLedger(ws);
      const host = new EffectHost(ledger);
      host.begin(effectId, "write", "call-bf");
      host.recordAllow(effectId);
      host.recordExecute(effectId, { ok: true });
      host.persistRecord(effectId, "unknown");

      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          type: EventTypes.toolCall,
          payload: {
            callId: "call-bf",
            name: "write",
            effectId,
            args: { path: "backfill.ts", content: "x" },
          },
        }) + "\n",
      );

      const host2 = new EffectHost();
      host2.hydrate(loadEffectLedger(ws).records);
      reconcileEffectsOnAttach(ws, sid, host2);
      const resolved = path.resolve(target);
      expect(observePendingResourceKeys(host2).get(resolved)).toEqual([effectId]);
      expect(host2.reconcileEffect(effectId)).toBe("unknown");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

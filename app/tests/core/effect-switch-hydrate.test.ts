import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core";
import { EffectHost } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import { refreshEffectHostFromDurableLedger } from "../../src/core/effect-reconcile-attach";

describe("cross-session EffectHost hydration", () => {
  test("switchSession sees effects added to disk after the runtime first hydrated", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-switch-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      const first = runtime.sessionId;
      runtime.newSession();
      const writer = new EffectHost(new WorkspaceEffectLedger(ws));
      const effectId = "d15154b2-a102-41f0-a876-9a312fe22211";
      const target = path.join(ws, "pending.ts");
      expect(runtime.getEffectRecord(effectId)).toBeUndefined();
      writer.begin(effectId, "write", "call-outside");
      writer.recordAllow(effectId);
      writer.recordExecute(effectId, { ok: true, resourceKey: target });
      writer.persistRecord(effectId, "unknown");

      runtime.switchSession(first);
      const restored = runtime.getEffectRecord(effectId);
      expect(restored?.steps.find((s) => s.phase === "execute")?.resourceKey).toBe(target);
      expect(runtime.unknownEffects().some((row) => row.effectId === effectId)).toBe(true);
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("disk refresh advances a stale host but never replaces locally unsafe observations", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-refresh-"));
    try {
      const effectId = "d15154b2-a102-41f0-a876-9a312fe22212";
      const writer = new EffectHost(new WorkspaceEffectLedger(ws));
      writer.begin(effectId, "read", "call");
      const stale = new EffectHost();
      stale.hydrate([writer.getRecord(effectId)!]);
      writer.recordAllow(effectId);
      writer.recordExecute(effectId, { ok: true });
      refreshEffectHostFromDurableLedger(ws, stale);
      expect(stale.getRecord(effectId)?.steps).toHaveLength(2);
      stale.recordObserve(effectId, { receiptId: "local", receiptSeq: 7, resultDigestEvidenceStable: false });
      writer.recordObserve(effectId, { receiptId: "disk", receiptSeq: 8 });
      refreshEffectHostFromDurableLedger(ws, stale);
      expect(stale.reconcileEffect(effectId)).toBe("unknown");
      expect(stale.getRecord(effectId)?.steps.at(-1)?.receiptId).toBe("local");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

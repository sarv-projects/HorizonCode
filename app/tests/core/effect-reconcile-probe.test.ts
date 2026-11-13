import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import {
  kernelReconcileVerdictFromParams,
  probeEffectReconcile,
  sessionReconcileVerdict,
} from "../../src/core/effect-reconcile-probe";
import { sessionEventsPath, receiptsPath } from "../../src/core/session-kernel-reconcile";

describe("effect-reconcile-probe (ruling 286)", () => {
  test("kernelReconcileVerdictFromParams mirrors local kernel settled/unknown", () => {
    expect(
      kernelReconcileVerdictFromParams({
        phases: ["allow", "execute", "observe"],
        receiptId: "r1",
        receiptSeq: 1,
      }),
    ).toBe("settled");
    expect(
      kernelReconcileVerdictFromParams({
        phases: ["allow", "execute"],
        receiptId: "r1",
        receiptSeq: 1,
      }),
    ).toBe("unknown");
    expect(
      kernelReconcileVerdictFromParams({
        phases: ["allow", "execute", "observe"],
        receiptId: "r1",
        receiptSeq: 1,
        postimageMissing: true,
      }),
    ).toBe("unknown");
  });

  test("probe reports no mismatches when ledger, session, and kernel agree", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-probe-ok-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "rcp-1", receiptSeq: 2 });
      host.persistRecord(id, sessionReconcileVerdict(host.getRecord(id)!));
      const report = probeEffectReconcile(ws);
      expect(report.effectsScanned).toBe(1);
      expect(report.mismatches).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("probe finds ledger_vs_session when persisted verdict is stale", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-probe-mis-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "rcp-1", receiptSeq: 2 });
      host.persistRecord(id, "unknown");
      const report = probeEffectReconcile(ws);
      expect(report.mismatches.some((m) => m.kind === "ledger_vs_session")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("session enrichment from logs does not mutate durable ledger", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-probe-enrich-"));
    try {
      const sid = "sess-probe";
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "read", "call-x");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.persistRecord(id, "unknown");
      const evFile = sessionEventsPath(ws, sid);
      mkdirSync(path.dirname(evFile), { recursive: true });
      writeFileSync(
        evFile,
        JSON.stringify({
          id: "ev1",
          seq: 1,
          type: EventTypes.receiptIssued,
          payload: { effectId: id, receiptId: "r-probe", seq: 9 },
        }) + "\n",
      );
      const rFile = receiptsPath(ws);
      mkdirSync(path.dirname(rFile), { recursive: true });
      writeFileSync(
        rFile,
        JSON.stringify({ id: "r-probe", seq: 9, tool: "read", effectId: id, action: "tool.execute" }) + "\n",
      );
      const report = probeEffectReconcile(ws, { sessionId: sid });
      expect(report.rows[0]?.sessionVerdict).toBe("settled");
      expect(report.mismatches.some((m) => m.kind === "ledger_vs_session")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

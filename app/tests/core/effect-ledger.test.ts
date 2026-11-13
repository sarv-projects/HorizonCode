import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import {
  WorkspaceEffectLedger,
  effectsLedgerPath,
  loadEffectLedger,
  recordToLedgerLine,
} from "../../src/core/effect-ledger";

describe("effect-ledger", () => {
  test("persists snapshots and reloads latest per effectId", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-eff-ledger-"));
    try {
      const ledger = new WorkspaceEffectLedger(ws);
      const host = new EffectHost(ledger);
      const id = createEffectId();
      host.begin(id, "read", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.persistRecord(id, "unknown");

      const file = effectsLedgerPath(ws);
      expect(readFileSync(file, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(3);

      const { records, verdicts } = loadEffectLedger(ws);
      expect(records.some((r) => r.effectId === id)).toBe(true);
      expect(verdicts.get(id)).toBe("unknown");

      const host2 = new EffectHost();
      host2.hydrate(records);
      expect(host2.reconcileEffect(id)).toBe("unknown");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("ledger line carries phases and receipt fields", () => {
    const id = createEffectId();
    const record = {
      effectId: id,
      tool: "write",
      callId: "call-x",
      steps: [
        { phase: "allow" as const, at: "t1" },
        { phase: "execute" as const, at: "t2", ok: true },
        { phase: "observe" as const, at: "t3", receiptId: "r1", receiptSeq: 2, postimageDigest: "dig" },
      ],
    };
    const line = recordToLedgerLine(record, "t3", "settled");
    expect(line.phases).toEqual(["allow", "execute", "observe"]);
    expect(line.receiptId).toBe("r1");
    expect(line.receiptSeq).toBe(2);
    expect(line.postimageDigest).toBe("dig");
    expect(line.verdict).toBe("settled");
  });
});

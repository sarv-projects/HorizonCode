import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import {
  EFFECT_RECONCILE_FAIL_EXIT,
  effectReconcileExitCode,
  renderEffectReconcile,
} from "../../src/core/effect-cli";

describe("effect-cli (ruling 291)", () => {
  test("observe-only reconcile does not mutate ledger", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-cli-obs-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "r1", receiptSeq: 1 });
      host.persistRecord(id, "unknown");
      const before = host.getRecord(id);
      const out = renderEffectReconcile(ws);
      expect(out).toContain("no ledger writes");
      expect(out).toContain("ledger mismatch");
      expect(effectReconcileExitCode(ws)).toBe(EFFECT_RECONCILE_FAIL_EXIT);
      const after = host.getRecord(id);
      expect(after?.steps.length).toBe(before?.steps.length);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("evidence failure exits 3", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-cli-ev-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, {
        receiptId: "r1",
        receiptSeq: 1,
        postimageObservationStable: false,
      });
      host.persistRecord(id, "unknown");
      expect(renderEffectReconcile(ws)).toContain("evidence gate");
      expect(effectReconcileExitCode(ws)).toBe(EFFECT_RECONCILE_FAIL_EXIT);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("--probe report is read-only", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-cli-prb-"));
    try {
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "read", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "r1", receiptSeq: 1 });
      host.persistRecord(id, "settled");
      const out = renderEffectReconcile(ws, { probe: true });
      expect(out).toContain("--probe");
      expect(out).toContain("agree");
      expect(effectReconcileExitCode(ws, { probe: true })).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/**
 * effect-kernel-reconcile.test.ts — live kernel effect.reconcile wire (ruling **261**).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EffectRecord } from "../../src/core/effect-host";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import {
  effectReconcileParamsFromRecord,
  mirrorEffectReconcileToKernel,
} from "../../src/core/effect-kernel-reconcile";
import { KernelClient } from "../../src/core/kernel";
import { hasRustKernel, rustKernelPath, setEnv, snapshotEnv, restoreEnv, type EnvSnapshot } from "./helpers";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-eff-krec-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function settledRecord(effectId: string): EffectRecord {
  return {
    effectId,
    tool: "write",
    callId: "c1",
    steps: [
      { phase: "allow", at: "t0", tool: "write", callId: "c1" },
      { phase: "execute", at: "t1", tool: "write", callId: "c1", ok: true },
      {
        phase: "observe",
        at: "t2",
        tool: "write",
        callId: "c1",
        receiptId: "rcp-1",
        receiptSeq: 2,
        resultDigestEvidenceStable: true,
        postimageMissingAtObserve: false,
      },
    ],
  };
}

describe("effectReconcileParamsFromRecord", () => {
  test("maps phases, receipt, and evidence flags", () => {
    const rec = settledRecord("e1");
    expect(effectReconcileParamsFromRecord(rec)).toEqual({
      phases: ["allow", "execute", "observe"],
      receiptId: "rcp-1",
      receiptSeq: 2,
      resultDigestStable: true,
      postimageMissing: false,
    });
  });

  test("omits stable flags when observe did not record them", () => {
    const rec = settledRecord("e1");
    rec.steps[2] = { ...rec.steps[2], resultDigestEvidenceStable: undefined, postimageMissingAtObserve: undefined };
    expect(effectReconcileParamsFromRecord(rec)).toEqual({
      phases: ["allow", "execute", "observe"],
      receiptId: "rcp-1",
      receiptSeq: 2,
    });
  });
});

describe("KernelClient.reconcileEffect", () => {
  test("local fallback agrees with EffectHost on settled lifecycle", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const params = effectReconcileParamsFromRecord(settledRecord("e1"))!;
      const out = await kernel.reconcileEffect(params);
      expect(out.verdict).toBe("settled");
      const host = new EffectHost();
      host.replaceRecord(settledRecord("e1"));
      expect(host.reconcileEffect("e1")).toBe("settled");
    } finally {
      await kernel.close();
    }
  });

  test("evidence flags force unknown on local fallback", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const rec = settledRecord("e1");
      rec.steps[2] = { ...rec.steps[2], resultDigestEvidenceStable: false };
      const out = await kernel.reconcileEffect(effectReconcileParamsFromRecord(rec)!);
      expect(out.verdict).toBe("unknown");
    } finally {
      await kernel.close();
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel evidence flags unknown", async () => {
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      await kernel.start();
      const rec = settledRecord(createEffectId());
      rec.steps[2] = { ...rec.steps[2], postimageMissingAtObserve: true };
      const out = await kernel.reconcileEffect(effectReconcileParamsFromRecord(rec)!);
      expect(out.verdict).toBe("unknown");
    } finally {
      await kernel.close();
      restoreEnv(envBackup);
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel mirror matches TS settled", async () => {
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      await kernel.start();
      const rec = settledRecord(createEffectId());
      const host = new EffectHost();
      host.replaceRecord(rec);
      expect(host.reconcileEffect(rec.effectId)).toBe("settled");
      const mirrored = await mirrorEffectReconcileToKernel(kernel, rec);
      expect(mirrored?.verdict).toBe("settled");
    } finally {
      await kernel.close();
      restoreEnv(envBackup);
    }
  });
});

describe("mirrorEffectReconcileToKernel", () => {
  test("swallows kernel errors; TS verdict unchanged", async () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "read", "c1");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true });
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1 });
    const broken = {
      reconcileEffect: async () => {
        throw new Error("transport down");
      },
    } as unknown as KernelClient;
    const before = host.reconcileEffect(effectId);
    const mirrored = await mirrorEffectReconcileToKernel(broken, host.getRecord(effectId));
    expect(mirrored).toBeUndefined();
    expect(host.reconcileEffect(effectId)).toBe(before);
  });
});

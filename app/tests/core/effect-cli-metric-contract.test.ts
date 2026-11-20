/**
 * effect-cli-metric-contract.test.ts — H-7 effect reconcile contracts (rulings 556/559/613).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  effectReconcileObservePublication,
  effectReconcileProbePublication,
  effectReconcilePublication,
  type EffectObserveReconcileReport,
} from "../../src/core/effect-cli";
import type { EffectEvidenceGateReport } from "../../src/core/effect-evidence-gate";
import type { EffectReconcileProbeReport } from "../../src/core/effect-reconcile-probe";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";

describe("effect reconcile H-7 metric contracts (rulings 556/559)", () => {
  test("effectReconcileObservePublication contracts observe summary counts", () => {
    const report: EffectObserveReconcileReport = {
      workspace: "/tmp/ws",
      rows: [
        {
          effectId: "eff-1",
          tool: "write",
          priorVerdict: "absent",
          sessionVerdict: "settled",
          wouldReconcile: true,
        },
        {
          effectId: "eff-2",
          tool: "shell",
          priorVerdict: "unknown",
          sessionVerdict: "settled",
          wouldReconcile: true,
        },
      ],
      mismatches: 1,
      wouldSettle: 2,
      evidence: {
        workspace: "/tmp/ws",
        effectsScanned: 2,
        failures: [{ effectId: "eff-2", tool: "shell", kind: "result_digest_unstable" }],
      },
    };
    const blocks = effectReconcileObservePublication(report);
    expect(blocks).toHaveLength(4);
    const values = blocks.map((b) => Number(parsePublishedNumber(b).value));
    expect(values).toEqual([2, 1, 2, 1]);
  });

  test("effectReconcileProbePublication contracts probe summary counts", () => {
    const report: EffectReconcileProbeReport = {
      workspace: "/tmp/ws",
      effectsScanned: 3,
      rows: [
        {
          effectId: "eff-1",
          tool: "write",
          callId: "c1",
          sessionVerdict: "settled",
          ledgerVerdict: "settled",
          kernelVerdict: "settled",
        },
        {
          effectId: "eff-2",
          tool: "edit",
          callId: "c2",
          sessionVerdict: "unknown",
          ledgerVerdict: "settled",
          kernelVerdict: "unknown",
        },
        {
          effectId: "eff-3",
          tool: "shell",
          callId: "c3",
          sessionVerdict: "settled",
          ledgerVerdict: "unknown",
          kernelVerdict: "settled",
        },
      ],
      mismatches: [
        {
          effectId: "eff-2",
          tool: "edit",
          kind: "ledger_vs_session",
          ledgerVerdict: "settled",
          sessionVerdict: "unknown",
          kernelVerdict: "unknown",
        },
        {
          effectId: "eff-3",
          tool: "shell",
          kind: "ledger_vs_session",
          ledgerVerdict: "unknown",
          sessionVerdict: "settled",
          kernelVerdict: "settled",
        },
      ],
    };
    const evidence: EffectEvidenceGateReport = {
      workspace: "/tmp/ws",
      effectsScanned: 3,
      failures: [{ effectId: "eff-2", tool: "edit", kind: "postimage_missing" }],
    };
    const blocks = effectReconcileProbePublication(report, evidence);
    expect(blocks).toHaveLength(4);
    // scanned=3, mismatches=2, openUnknown=2 (eff-2 session + eff-3 ledger), evidence=1
    expect(blocks.map((b) => Number(parsePublishedNumber(b).value))).toEqual([3, 2, 2, 1]);
  });

  test("effectReconcilePublication routes observe vs probe for CLI emit (ruling 613)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-effect-cli-pub-"));
    try {
      const observe = effectReconcilePublication(ws, { probe: false });
      expect(observe.length).toBeGreaterThan(0);
      for (const block of observe) assertPublishedNumber(block);
      expect(observe.some((b) => parsePublishedNumber(b).metric.includes("observe"))).toBe(true);

      const probe = effectReconcilePublication(ws, { probe: true });
      expect(probe.length).toBeGreaterThan(0);
      for (const block of probe) assertPublishedNumber(block);
      expect(probe.some((b) => parsePublishedNumber(b).metric.includes("probe"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

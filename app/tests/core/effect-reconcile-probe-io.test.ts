import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { WorkspaceEffectLedger } from "../../src/core/effect-ledger";
import {
  enrichProbeMismatchesWithIo,
  probeGitStatusPorcelain,
  probeResourcePath,
  resourceKeyFromEffectRecord,
} from "../../src/core/effect-reconcile-probe-io";
import { probeEffectReconcile, sessionReconcileVerdict } from "../../src/core/effect-reconcile-probe";

describe("effect-reconcile-probe-io (ruling 290)", () => {
  test("probeResourcePath reports file stat", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-probe-io-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");
    try {
      const p = probeResourcePath(file);
      expect(p.exists).toBe(true);
      expect(p.kind).toBe("file");
      expect(p.size).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resourceKeyFromEffectRecord reads observe step", () => {
    const host = new EffectHost();
    const id = createEffectId();
    host.begin(id, "write", "c1");
    host.recordObserve(id, { receiptId: "r1", receiptSeq: 1, resourceKey: "/tmp/x" });
    expect(resourceKeyFromEffectRecord(host.getRecord(id))).toBe("/tmp/x");
  });

  test("probeGitStatusPorcelain uses injected runner (no git required)", () => {
    const snap = probeGitStatusPorcelain("/tmp/ws", {
      run: () => ({ ok: true, stdout: " M foo.txt\n?? bar.txt\n", stderr: "" }),
    });
    expect(snap.available).toBe(true);
    expect(snap.porcelainLineCount).toBe(2);
    expect(snap.porcelainPreview[0]).toContain("foo.txt");
  });

  test("probe enriches mismatches with fs probe only (read-only)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-probe-io-mis-"));
    try {
      const rel = path.join(ws, "out.txt");
      writeFileSync(rel, "data");
      const host = new EffectHost(new WorkspaceEffectLedger(ws));
      const id = createEffectId();
      host.begin(id, "write", "c1");
      host.recordAllow(id);
      host.recordExecute(id, { ok: true });
      host.recordObserve(id, { receiptId: "rcp-1", receiptSeq: 2, resourceKey: rel });
      host.persistRecord(id, "unknown");
      const report = probeEffectReconcile(ws, {
        effectHost: { listEffectIds: () => host.listEffectIds(), getRecord: (eid) => host.getRecord(eid) },
      });
      expect(report.mismatches.length).toBeGreaterThan(0);
      expect(report.ioHints?.length).toBe(1);
      expect(report.ioHints?.[0]?.resource?.exists).toBe(true);
      expect(report.vcsSnapshot).toBeDefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("enrichProbeMismatchesWithIo skips effects without resourceKey", () => {
    const hints = enrichProbeMismatchesWithIo(
      [{ effectId: "e1", tool: "read", kind: "ledger_vs_session", sessionVerdict: "unknown" }],
      () => ({ effectId: "e1", tool: "read", callId: "c", steps: [] }),
    );
    expect(hints).toEqual([]);
  });
});

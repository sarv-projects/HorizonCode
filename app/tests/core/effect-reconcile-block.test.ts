/**
 * effect-reconcile-block.test.ts — HZ_EFFECT_RECONCILE_BLOCK (ruling **293**).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes, newId, nowIso } from "../../src/contracts";
import {
  __resetEffectReconcileBlockForTests,
  assessEffectReconcileBlock,
  effectReconcileBlockObservePendingRefusal,
  effectReconcileBlockRefusal,
  effectReconcileBlockEnabled,
  effectReconcileBlockMode,
  effectReconcileBlockLatchView,
  formatEffectReconcileBlockStatusLines,
  formatReconcileBlockListLines,
  formatReconcileBlockResourceDependencyLines,
  formatObservePendingDependencyLines,
  reconcileBlockObservePendingDependencies,
  reconcileBlockResourceDependencies,
  effectReconcileBlockLatchBlockedPaths,
  isEffectReconcileBlockLatched,
  __latchEffectReconcileBlockForTests,
  latchEffectReconcileBlock,
  tryReleaseEffectReconcileBlock,
} from "../../src/core/effect-reconcile-block";
import { writeFileSync } from "node:fs";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { KernelClient } from "../../src/core/kernel";
import { kernelStateDir } from "../../src/core/paths";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;
let envBackup: EnvSnapshot;

beforeEach(() => {
  envBackup = snapshotEnv();
  workspace = mkdtempSync(path.join(tmpdir(), "hz-recon-block-"));
  __resetEffectReconcileBlockForTests();
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  restoreEnv(envBackup);
  __resetEffectReconcileBlockForTests();
});

describe("effectReconcileBlockEnabled", () => {
  test("off unless opt-in", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "" });
    expect(effectReconcileBlockEnabled()).toBe(false);
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
    expect(effectReconcileBlockEnabled()).toBe(true);
    expect(effectReconcileBlockMode()).toBe("session");
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    expect(effectReconcileBlockMode()).toBe("resource");
  });
});

describe("observe-pending gate (rulings 333, 334)", () => {
  test("refuses ast_edit on path while prior effect execute has not observed", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "pending.ts");
    host.begin(effectId, "apply_patch", "call-inflight");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "ast_edit",
      { path: "pending.ts", pat: "x", out: "y" },
      host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain(effectId.slice(0, 13));
    const writeRefusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "write",
      { path: "pending.ts", content: "z" },
      host,
    );
    expect(writeRefusal).toContain("observe not settled");
    expect(writeRefusal).toContain("refusing write");
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: target });
    expect(
      effectReconcileBlockObservePendingRefusal(
        workspace,
        "ast_edit",
        { path: "pending.ts", pat: "x", out: "y" },
        host,
      ),
    ).toBeUndefined();
  });

  test("refuses edit on overlapping path (ruling 334)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "sub", "lane.ts");
    host.begin(effectId, "write", "w1");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "edit",
      { path: "sub/lane.ts", old: "a", new: "b" },
      host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain("refusing edit");
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, "edit", { path: "other.ts", old: "a", new: "b" }, host),
    ).toBeUndefined();
  });

  test("shell skipped when no postimage path (ruling 334)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "sh.ts");
    host.begin(effectId, "write", "w-sh");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, "shell", { command: "echo hi" }, host),
    ).toBeUndefined();
  });

  test("shell refused when explicit cwd overlaps observe-pending path (ruling 336)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "sub", "lane.ts");
    host.begin(effectId, "write", "w336");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "shell",
      { command: "npm test", cwd: "sub" },
      host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain("refusing shell");
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, "shell", { command: "npm test", cwd: "other" }, host),
    ).toBeUndefined();
  });

  test("shell refused when explicit path overlaps (ruling 336)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "explicit.ts");
    host.begin(effectId, "edit", "e336");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "shell",
      { command: "cat explicit.ts", path: "explicit.ts" },
      host,
    );
    expect(refusal).toContain("refusing shell");
  });

  test("off when HZ_EFFECT_RECONCILE_BLOCK unset", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "" });
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "off.ts");
    host.begin(effectId, "write", "c1");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, "apply_patch", { patch: "*** off.ts\n+x" }, host),
    ).toBeUndefined();
  });
});

describe("latch + refusal", () => {
  test("latches on unpaired session tool.call", async () => {
    const sid = "sess-block";
    const kernel = new KernelClient({ workspace, stateDir: kernelStateDir(workspace) });
    const stream = `session:${sid}`;
    try {
      await kernel.appendEvent(stream, {
        id: newId(),
        ts: nowIso(),
        stream,
        type: EventTypes.toolCall,
        actor: { kind: "tool", id: "write" },
        payload: { id: "orphan", name: "write" },
      });
      const notice = latchEffectReconcileBlock(workspace, sid);
      expect(notice).toContain("HZ_EFFECT_RECONCILE_BLOCK");
      expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
      const refusal = effectReconcileBlockRefusal(workspace, sid, "write");
      expect(refusal).toContain("refusing write");
      expect(effectReconcileBlockRefusal(workspace, sid, "read")).toBeUndefined();
    } finally {
      await kernel.close();
    }
  });

  test("tryRelease clears latch when ledger is clean", () => {
    const sid = "sess-clear";
    __latchEffectReconcileBlockForTests(workspace, sid);
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
    const released = tryReleaseEffectReconcileBlock(workspace, sid);
    expect(released).toBe(true);
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(false);
  });

  test("assess reports clean empty workspace", () => {
    const assessment = assessEffectReconcileBlock(workspace, "none");
    expect(assessment.shouldBlock).toBe(false);
  });
});

describe("resource mode path filter (ruling 302)", () => {
  test("allows mutating tool on a different path when latched with blocked paths", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    const sid = "sess-resource";
    const blocked = path.join(workspace, "hot.ts");
    writeFileSync(blocked, "x", "utf8");
    __latchEffectReconcileBlockForTests(workspace, sid, "probe mismatch", [blocked]);
    expect(
      effectReconcileBlockRefusal(workspace, sid, "write", { path: "other.ts", content: "y" }),
    ).toBeUndefined();
    const refusal = effectReconcileBlockRefusal(workspace, sid, "write", { path: "hot.ts", content: "z" });
    expect(refusal).toContain("HZ_EFFECT_RECONCILE_BLOCK=resource");
    expect(refusal).toContain("refusing write");
  });
});

describe("latch view for TUI (ruling 304, 307)", () => {
  test("latch view includes blocked paths", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    const sid = "sess-paths";
    const blocked = path.join(workspace, "blocked.ts");
    __latchEffectReconcileBlockForTests(workspace, sid, "test", [blocked]);
    const view = effectReconcileBlockLatchView(workspace, sid);
    expect(view.blockedPaths).toEqual([blocked]);
    expect(formatReconcileBlockListLines(view).join("\n")).toContain("blocked.ts");
    expect(effectReconcileBlockLatchBlockedPaths(workspace, sid)).toEqual([blocked]);
  });

  test("resource dependency lines explain blocked paths (ruling 316)", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    const sid = "sess-deps";
    const blocked = path.join(workspace, "blocked.ts");
    __latchEffectReconcileBlockForTests(workspace, sid, "probe mismatch", [blocked]);
    const deps = [
      {
        resourcePath: blocked,
        effectId: "eff-blocked-1",
        because: "probe mismatch (ledger_vs_session)",
      },
    ];
    const lines = formatReconcileBlockResourceDependencyLines(deps);
    expect(lines.some((l) => l.includes("blocked.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("ledger_vs_session"))).toBe(true);
    const status = formatEffectReconcileBlockStatusLines({
      latched: true,
      mode: "resource",
      reason: "probe mismatch",
      blockedPaths: [blocked],
      resourceDependencies: deps,
    });
    expect(status.some((l) => l.includes("per-resource block drivers"))).toBe(true);
    expect(reconcileBlockResourceDependencies(workspace, sid).length).toBe(0);
  });

  test("latch view surfaces observe-pending drivers (ruling 342)", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "observe-pane.ts");
    host.begin(effectId, "write", "w-342");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const view = effectReconcileBlockLatchView(workspace, "sess-342", host);
    expect(view.latched).toBe(false);
    expect(view.observePendingActive).toBe(true);
    expect(reconcileBlockObservePendingDependencies(host).map((d) => d.resourcePath)).toEqual([target]);
    const lines = formatObservePendingDependencyLines(view.observePendingDependencies ?? []);
    expect(lines.some((l) => l.includes("observe-pane.ts"))).toBe(true);
    const status = formatEffectReconcileBlockStatusLines(view);
    expect(status.some((l) => l.includes("observe-pending"))).toBe(true);
    host.recordObserve(effectId, { receiptId: "r342", receiptSeq: 1, resourceKey: target });
    const cleared = effectReconcileBlockLatchView(workspace, "sess-342", host);
    expect(cleared.observePendingActive).toBeUndefined();
  });

  test("effectReconcileBlockLatchView reflects test latch", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
    const sid = "sess-view";
    expect(effectReconcileBlockLatchView(workspace, sid).latched).toBe(false);
    __latchEffectReconcileBlockForTests(workspace, sid, "test reason");
    const view = effectReconcileBlockLatchView(workspace, sid);
    expect(view.latched).toBe(true);
    expect(view.reason).toBe("test reason");
    expect(formatEffectReconcileBlockStatusLines(view).join("\n")).toContain("LATCHED");
  });
});

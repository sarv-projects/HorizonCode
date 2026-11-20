/**
 * effect-reconcile-block.test.ts — HZ_EFFECT_RECONCILE_BLOCK (ruling **293**).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes, newId, nowIso } from "../../src/contracts";
import {
  __resetEffectReconcileBlockForTests,
  assessEffectReconcileBlock,
  effectReconcileBlockObservePendingRefusal,
  effectReconcileBlockObservationHookRefusal,
  effectReconcileBlockPreToolHookRefusal,
  EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE,
  EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE,
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
import { appendReconcileLatch, reconcileLatchFile } from "../../src/core/effect-reconcile-latch-store";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { KernelClient } from "../../src/core/kernel";
import { kernelStateDir } from "../../src/core/paths";
import { HOOK_POINTS, type HooksConfig } from "../../src/core/hooks";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

function hooksWithPreToolCount(count: number): HooksConfig {
  if (count === 0) return { state: "none" };
  const empty = Object.fromEntries(HOOK_POINTS.map((p) => [p, []])) as Record<
    (typeof HOOK_POINTS)[number],
    []
  >;
  return {
    state: "ready",
    points: {
      ...empty,
      preTool: Array.from({ length: count }, () => ({
        command: "true",
        args: [] as string[],
        source: "hooks.json",
        timeoutMs: 30_000,
      })),
    },
    sources: ["hooks.json"],
  };
}

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

  test("unscoped shell is denied while any resource remains observe-pending", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "sh.ts");
    host.begin(effectId, "write", "w-sh");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refused = effectReconcileBlockObservePendingRefusal(workspace, "shell", { command: "echo hi" }, host);
    expect(refused).toContain("observe not settled");
    expect(refused).toContain("unknown resource");
    host.recordObserve(effectId, { receiptId: "r-shell", receiptSeq: 1 });
    expect(effectReconcileBlockObservePendingRefusal(workspace, "shell", { command: "echo hi" }, host)).toBeUndefined();
  });

  test("observe-pending barrier checks every file in a multi-op patch", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const hot = path.join(workspace, "hot.ts");
    host.begin(effectId, "write", "pending-hot");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: hot });
    const patch = "*** Begin Patch\n*** Add File: hot.ts\n+hot\n*** Add File: cold.ts\n+cold\n*** End Patch";
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace, "apply_patch", { input: patch }, host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain(effectId.slice(0, 13));
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
    // An apparently disjoint cwd is not proof: commands can reference
    // absolute paths or ../ into a different pending resource.
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, "shell", { command: "npm test", cwd: "other" }, host),
    ).toContain("unknown resource");
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

  test("refuses mutating MCP on overlapping path while observe-pending (ruling 683)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "mcp-pending.ts");
    host.begin(effectId, "write", "w-mcp");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const tool = "mcp__srv__write_file";
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      tool,
      { path: "mcp-pending.ts", content: "x" },
      host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain(`refusing ${tool}`);
    expect(
      effectReconcileBlockObservePendingRefusal(workspace, tool, { path: "other.ts", content: "x" }, host),
    ).toBeUndefined();
  });

  test("unscoped mutating MCP denied while any resource observe-pending (ruling 683)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "any.ts");
    host.begin(effectId, "write", "w-any");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservePendingRefusal(
      workspace,
      "mcp__srv__do_thing",
      { payload: "opaque" },
      host,
    );
    expect(refusal).toContain("observe not settled");
    expect(refusal).toContain("unknown resource");
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

  test("a clean end-of-turn assessment never silently releases a prior latch", () => {
    const sid = "sess-sticky";
    __latchEffectReconcileBlockForTests(workspace, sid, "earlier UNKNOWN");
    const notice = latchEffectReconcileBlock(workspace, sid);
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
    expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "x.ts", content: "x" })).toContain(
      "refusing write",
    );
    expect(notice).toContain("earlier UNKNOWN");
    expect(tryReleaseEffectReconcileBlock(workspace, sid)).toBe(true);
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(false);
  });

  test("a latch survives in-memory reset and only a clean explicit release persists its removal", () => {
    const sid = "sess-durable";
    __latchEffectReconcileBlockForTests(workspace, sid, "previously unpaired");
    __resetEffectReconcileBlockForTests(); // simulate a different process attaching
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
    expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "x.txt", content: "x" })).toContain(
      "previously unpaired",
    );
    expect(tryReleaseEffectReconcileBlock(workspace, sid)).toBe(true);
    __resetEffectReconcileBlockForTests();
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(false);
  });

  test("a release from another runtime invalidates this process's stale latch cache", () => {
    const sid = "sess-remote-release";
    __latchEffectReconcileBlockForTests(workspace, sid, "old failure");
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
    appendReconcileLatch(workspace, sid, null); // independent verified release
    expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(false);
    expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "free.ts", content: "x" })).toBeUndefined();
  });

  test("malformed durable latch state refuses mutations rather than assuming clean", () => {
    const file = reconcileLatchFile(workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json}\n");
    expect(effectReconcileBlockRefusal(workspace, "sess-corrupt", "write", {
      path: "maybe.ts", content: "x",
    })).toContain("journal unreadable or malformed");
    expect(effectReconcileBlockRefusal(workspace, "sess-corrupt", "read", {
      path: "maybe.ts",
    })).toBeUndefined();
  });

  test("a first mutator admission latches an existing orphan without an earlier turn-end call", async () => {
    const sid = "sess-preflight";
    const kernel = new KernelClient({ workspace, stateDir: kernelStateDir(workspace) });
    const stream = `session:${sid}`;
    try {
      await kernel.appendEvent(stream, {
        id: newId(), ts: nowIso(), stream, type: EventTypes.toolCall,
        actor: { kind: "tool", id: "write" },
        payload: { id: "orphan-at-start", name: "write" },
      });
      expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(false);
      const refused = effectReconcileBlockRefusal(workspace, sid, "write", {
        path: "hazard.ts", content: "do not execute",
      });
      expect(refused).toContain("refusing write");
      expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
      __resetEffectReconcileBlockForTests();
      expect(isEffectReconcileBlockLatched(workspace, sid)).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  test("assess reports clean empty workspace", () => {
    const assessment = assessEffectReconcileBlock(workspace, "none");
    expect(assessment.shouldBlock).toBe(false);
  });
});

describe("resource mode path filter (ruling 302)", () => {
  test("an unscoped latch cannot be narrowed by later path-scoped evidence", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    const sid = "sess-sticky-unscoped";
    __latchEffectReconcileBlockForTests(workspace, sid, "unattributable effect", []);
    __latchEffectReconcileBlockForTests(workspace, sid, "new scoped effect", [path.join(workspace, "hot.ts")]);
    expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "cold.ts", content: "x" })).toContain(
      "refusing write",
    );
  });

  test("new unattributed evidence widens a previously scoped latch to session-wide", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
    const sid = "sess-widen-unscoped";
    __latchEffectReconcileBlockForTests(workspace, sid, "scoped", [path.join(workspace, "hot.ts")]);
    __latchEffectReconcileBlockForTests(workspace, sid, "unattributable", []);
    expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "cold.ts", content: "x" })).toContain(
      "refusing write",
    );
  });

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

test("resource latch refuses an unscoped shell while allowing known disjoint file mutation", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-resource-unscoped";
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown file effect", [
    path.join(workspace, "hot.ts"),
  ]);
  const refusal = effectReconcileBlockRefusal(workspace, sid, "shell", { command: "echo x > hot.ts" });
  expect(refusal).toContain("refusing shell");
  expect(refusal).toContain("unknown resource");
  expect(effectReconcileBlockRefusal(workspace, sid, "write", { path: "cold.ts", content: "ok" })).toBeUndefined();
});

test("resource latch refuses writes via symlink aliases to blocked files", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-symlink-alias";
  const target = path.join(workspace, "hot.ts");
  writeFileSync(target, "original");
  symlinkSync(target, path.join(workspace, "alias.ts"));
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown hot effect", [target]);
  const refusal = effectReconcileBlockRefusal(workspace, sid, "write", {
    path: "alias.ts", content: "must be blocked",
  });
  expect(refusal).toContain("refusing write");
});

test("resource latch refuses writes via hardlink aliases (device,inode) when paths differ (ruling 695)", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-hardlink-alias";
  const target = path.join(workspace, "blocked-primary.ts");
  const hardlink = path.join(workspace, "nested", "hardalias.ts");
  mkdirSync(path.dirname(hardlink), { recursive: true });
  writeFileSync(target, "original");
  linkSync(target, hardlink);
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown file effect", [target]);
  const refusal = effectReconcileBlockRefusal(workspace, sid, "write", {
    path: path.relative(workspace, hardlink),
    content: "via hardlink",
  });
  expect(refusal).toContain("refusing write");
  expect(refusal).toContain("hardalias.ts");
  expect(
    effectReconcileBlockRefusal(workspace, sid, "write", { path: "other.ts", content: "ok" }),
  ).toBeUndefined();
});

test("resource latch refuses writes via dangling symlink when target absent (ruling 699)", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-dangling-alias";
  const target = path.join(workspace, "hot.ts");
  const link = path.join(workspace, "dangle.ts");
  symlinkSync(target, link);
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown hot effect", [target]);
  const refusalOverlap = effectReconcileBlockRefusal(workspace, sid, "write", {
    path: "dangle.ts",
    content: "via dangling",
  });
  expect(refusalOverlap).toContain("refusing write");

  const cold = path.join(workspace, "cold.ts");
  writeFileSync(cold, "c");
  const danglingCold = path.join(workspace, "dangle-cold.ts");
  symlinkSync(path.join(workspace, "will-never-exist.ts"), danglingCold);
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown cold effect", [cold]);
  const refusalUncertain = effectReconcileBlockRefusal(workspace, sid, "write", {
    path: "dangle-cold.ts",
    content: "maybe cold",
  });
  expect(refusalUncertain).toContain("dangling symlink");
  expect(refusalUncertain).toContain("final link target absent");
});

test("resource latch observe-pending refuses hardlink alias to pending file (ruling 695)", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const host = new EffectHost();
  const effectId = createEffectId();
  const primary = path.join(workspace, "observe-primary.ts");
  const hardlink = path.join(workspace, "observe-hard.ts");
  writeFileSync(primary, "x");
  linkSync(primary, hardlink);
  host.begin(effectId, "write", "w-hl-obs");
  host.recordAllow(effectId);
  host.recordExecute(effectId, { ok: true, resourceKey: primary });
  const refusal = effectReconcileBlockObservePendingRefusal(
    workspace,
    "write",
    { path: path.relative(workspace, hardlink), content: "y" },
    host,
  );
  expect(refusal).toContain("observe not settled");
  expect(refusal).toContain("refusing write");
});

test("shell cwd outside blocked paths cannot certify arbitrary command effects", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-shell-cwd-bypass";
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown hot effect", [
    path.join(workspace, "hot.ts"),
  ]);
  const refusal = effectReconcileBlockRefusal(workspace, sid, "shell", {
    cwd: "other", command: "sh -c 'echo malicious > ../hot.ts'",
  });
  expect(refusal).toContain("refusing shell");
  expect(refusal).toContain("unknown resource");
});

test("multi-file apply_patch cannot hide a blocked earlier file behind a disjoint final file", () => {
  setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "resource" });
  const sid = "sess-multi-patch";
  __latchEffectReconcileBlockForTests(workspace, sid, "unknown hot effect", [
    path.join(workspace, "hot.ts"),
  ]);
  const patch = "*** Begin Patch\n*** Add File: hot.ts\n+hot\n*** Add File: cold.ts\n+cold\n*** End Patch";
  const refusal = effectReconcileBlockRefusal(workspace, sid, "apply_patch", { input: patch });
  expect(refusal).toContain("refusing apply_patch");
});

test("an active reconcile latch refuses unclassified effect paths but permits read-only tools", () => {
  const sid = "sess-new-tool";
  __latchEffectReconcileBlockForTests(workspace, sid, "pending effects");
  for (const name of ["shell_session", "code_mode", "agent", "preview", "todo", "mcp__remote__write", "new_tool"]) {
    expect(effectReconcileBlockRefusal(workspace, sid, name, {})).toContain(`refusing ${name}`);
  }
  for (const name of ["read", "grep", "glob", "repo_map", "ast_search", "tool_search", "memory_search"]) {
    expect(effectReconcileBlockRefusal(workspace, sid, name, {})).toBeUndefined();
  }
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

describe("preTool hook reconcile barrier (ruling 691)", () => {
  test("refuses deciding hooks when session latch is active", () => {
    const sid = "sess-pretool-latch";
    __latchEffectReconcileBlockForTests(workspace, sid, "probe mismatch");
    const refusal = effectReconcileBlockPreToolHookRefusal(
      workspace,
      sid,
      hooksWithPreToolCount(2),
    );
    expect(refusal).toContain(EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE);
    expect(refusal).toContain("preTool hook spawn");
    expect(refusal).toContain("2 deciding hook");
    expect(refusal).toContain("probe mismatch");
  });

  test("refuses deciding hooks during observe-pending without latch", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "hook-pending.ts");
    host.begin(effectId, "write", "w-hook");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockPreToolHookRefusal(
      workspace,
      "sess-pretool-observe",
      hooksWithPreToolCount(1),
      host,
    );
    expect(refusal).toContain(EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE);
    expect(refusal).toContain("observe-pending");
    host.recordObserve(effectId, { receiptId: "r-hook", receiptSeq: 1, resourceKey: target });
    expect(
      effectReconcileBlockPreToolHookRefusal(
        workspace,
        "sess-pretool-observe",
        hooksWithPreToolCount(1),
        host,
      ),
    ).toBeUndefined();
  });

  test("no preTool hooks or reconcile off → no refusal", () => {
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "" });
    expect(
      effectReconcileBlockPreToolHookRefusal(workspace, "sid", hooksWithPreToolCount(1)),
    ).toBeUndefined();
    setEnv({ HZ_EFFECT_RECONCILE_BLOCK: "1" });
    expect(
      effectReconcileBlockPreToolHookRefusal(workspace, "sid", { state: "none" }),
    ).toBeUndefined();
    expect(
      effectReconcileBlockPreToolHookRefusal(workspace, "sid", hooksWithPreToolCount(0)),
    ).toBeUndefined();
  });
});

function hooksWithPostToolCount(count: number): HooksConfig {
  if (count === 0) return { state: "none" };
  const empty = Object.fromEntries(HOOK_POINTS.map((p) => [p, []])) as Record<
    (typeof HOOK_POINTS)[number],
    []
  >;
  return {
    state: "ready",
    points: {
      ...empty,
      postTool: Array.from({ length: count }, () => ({
        point: "postTool" as const,
        index: 0,
        source: "test",
        command: "/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
    },
    sources: ["test"],
  };
}

describe("observation hook reconcile barrier (ruling 718)", () => {
  test("refuses postTool hooks when session latch is active", () => {
    const sid = "sess-posttool-latch";
    __latchEffectReconcileBlockForTests(workspace, sid, "probe mismatch");
    const refusal = effectReconcileBlockObservationHookRefusal(
      workspace,
      sid,
      hooksWithPostToolCount(2),
      undefined,
      { point: "postTool", tool: "write" },
    );
    expect(refusal).toContain(EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE);
    expect(refusal).toContain("postTool hook spawn");
    expect(refusal).toContain("2 observation hook");
  });

  test("refuses lifecycle hooks during observe-pending without latch", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const target = path.join(workspace, "lifecycle-pending.ts");
    host.begin(effectId, "write", "w-lifecycle");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: target });
    const refusal = effectReconcileBlockObservationHookRefusal(
      workspace,
      "sess-lifecycle-observe",
      hooksWithLifecycleCount(1),
      host,
      { point: "turnStart" },
    );
    expect(refusal).toContain(EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE);
    expect(refusal).toContain("lifecycle turnStart");
    host.recordObserve(effectId, { receiptId: "r-lifecycle", receiptSeq: 1, resourceKey: target });
    expect(
      effectReconcileBlockObservationHookRefusal(
        workspace,
        "sess-lifecycle-observe",
        hooksWithLifecycleCount(1),
        host,
        { point: "turnStart" },
      ),
    ).toBeUndefined();
  });
});

function hooksWithLifecycleCount(count: number): HooksConfig {
  if (count === 0) return { state: "none" };
  const empty = Object.fromEntries(HOOK_POINTS.map((p) => [p, []])) as Record<
    (typeof HOOK_POINTS)[number],
    []
  >;
  return {
    state: "ready",
    points: {
      ...empty,
      turnStart: Array.from({ length: count }, () => ({
        point: "turnStart" as const,
        index: 0,
        source: "test",
        command: "/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
    },
    sources: ["test"],
  };
}

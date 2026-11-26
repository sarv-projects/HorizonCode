/**
 * hooks-reconcile-preflight.test.ts — hook execution refusal under reconcile barrier.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  runPreToolHooks,
  runPostToolHooks,
  runLifecycleHooks,
  type HookContext,
  type PostToolHookContext,
  type LifecycleHookContext,
  type HooksConfig,
} from "../../src/core/hooks";
import {
  __latchEffectReconcileBlockForTests,
  __resetEffectReconcileBlockForTests,
  EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE,
  EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE,
} from "../../src/core/effect-reconcile-block";

let workspace: string;
const sid = "sess-hook-preflight";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-preflight-"));
  process.env.HZ_EFFECT_RECONCILE_BLOCK = "1";
});

afterEach(() => {
  delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
  __resetEffectReconcileBlockForTests();
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore on Windows */
  }
});

function mockConfig(): HooksConfig {
  return {
    state: "ready",
    points: {
      preTool: [{ point: "preTool", command: "echo", args: ["allowed"], timeoutMs: 1000, source: "test", index: 0 }],
      postTool: [{ point: "postTool", command: "echo", args: ["observed"], timeoutMs: 1000, source: "test", index: 0 }],
      sessionStart: [{ point: "sessionStart", command: "echo", args: ["start"], timeoutMs: 1000, source: "test", index: 0 }],
      sessionEnd: [],
      turnStart: [],
      turnEnd: [],
      compactPre: [],
      compactPost: [],
      subagentStart: [],
      subagentStop: [],
    },
    refusals: [],
  };
}

describe("Hooks Reconcile Barrier Preflight (Ruling 869)", () => {
  test("runPreToolHooks denies before spawn when reconcile latch is active", async () => {
    __latchEffectReconcileBlockForTests(workspace, sid, "unpaired tool effect");

    const events: Array<{ type: string; payload: unknown }> = [];
    const ctx: HookContext = {
      workspace,
      sessionId: sid,
      callId: "call_1",
      tool: "write",
      args: { path: "a.txt" },
      onEvent(type, payload) {
        events.push({ type, payload });
      },
    };

    const decision = await runPreToolHooks(mockConfig(), ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(EFFECT_RECONCILE_BLOCK_PRETOOL_HOOK_NOTICE);
    expect(decision.reason).toContain("unpaired tool effect");
    expect(events.some((e) => e.type === "hook.decision")).toBe(true);
  });

  test("runPostToolHooks suppresses execution and returns empty fragments on latch", async () => {
    __latchEffectReconcileBlockForTests(workspace, sid, "unpaired tool effect");

    const notices: string[] = [];
    const ctx: PostToolHookContext = {
      workspace,
      sessionId: sid,
      callId: "call_1",
      tool: "write",
      args: { path: "a.txt" },
      ok: true,
      ms: 10,
      outputExcerpt: "written",
      onNotice(msg) {
        notices.push(msg);
      },
    };

    const fragments = await runPostToolHooks(mockConfig(), ctx);
    expect(fragments).toEqual([]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE);
  });

  test("runLifecycleHooks suppresses execution on latch", async () => {
    __latchEffectReconcileBlockForTests(workspace, sid, "unpaired tool effect");

    const notices: string[] = [];
    const ctx: LifecycleHookContext = {
      workspace,
      sessionId: sid,
      point: "sessionStart",
      onNotice(msg) {
        notices.push(msg);
      },
    };

    const fragments = await runLifecycleHooks(mockConfig(), ctx);
    expect(fragments).toEqual([]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(EFFECT_RECONCILE_BLOCK_OBSERVATION_HOOK_NOTICE);
  });
});

/**
 * Rulings 651 + 666 — user hooks are not spawned when EffectHost is on
 * (=require, =default, =1); Bun hook processes are ambient until kernel-routed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import {
  EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE,
  EFFECT_HOST_KERNEL_REQUIRE_HOOKS_SUPPRESSED_NOTICE,
  effectHostHooksSuppressedNotice,
  effectHostRequireSuppressHooks,
} from "../../src/core/effect-host-posture";
import { loadHooks } from "../../src/core/hooks";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { workspaceStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

describe("effectHostRequireSuppressHooks (rulings 651 + 666)", () => {
  test("suppresses non-none configs whenever EffectHost is on", () => {
    const snap = snapshotEnv();
    try {
      const ready = { state: "ready" as const, points: { preTool: [] }, sources: [] };
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      const out = effectHostRequireSuppressHooks(ready);
      expect(out.suppressed).toBe(true);
      expect(out.hooks).toEqual({ state: "none" });

      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      const underDefault = effectHostRequireSuppressHooks(ready);
      expect(underDefault.suppressed).toBe(true);
      expect(underDefault.hooks).toEqual({ state: "none" });

      setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
      const underOptIn = effectHostRequireSuppressHooks(ready);
      expect(underOptIn.suppressed).toBe(true);

      setEnv({ HZ_EFFECT_HOST_KERNEL: undefined });
      delete process.env.HZ_EFFECT_HOST_KERNEL;
      const off = effectHostRequireSuppressHooks(ready);
      expect(off.suppressed).toBe(false);
      expect(off.hooks).toBe(ready);
    } finally {
      restoreEnv(snap);
    }
  });

  test("notice matches mode", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
      expect(effectHostHooksSuppressedNotice()).toBe(EFFECT_HOST_KERNEL_REQUIRE_HOOKS_SUPPRESSED_NOTICE);
      setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
      expect(effectHostHooksSuppressedNotice()).toBe(EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE);
      setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
      expect(effectHostHooksSuppressedNotice()).toBe(EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE);
    } finally {
      restoreEnv(snap);
    }
  });
});

let workspace = "";
let home = "";
let envSnap: EnvSnapshot;

beforeEach(() => {
  envSnap = snapshotEnv();
  workspace = mkdtempSync(path.join(tmpdir(), "hz-req-hooks-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-req-hooks-home-"));
  setEnv({
    HOME: home,
    HZ_EFFECT_HOST_KERNEL: "require",
  });
});

afterEach(() => {
  restoreEnv(envSnap);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function expectHookNotSpawnedUnderEffectHost(kernelMode: string, notice: string): Promise<void> {
  const marker = path.join(workspace, `hook-${kernelMode}.txt`);
  const hooksDir = path.join(workspace, ".hzcode");
  mkdirSync(hooksDir, { recursive: true });
  const hookScript = path.join(hooksDir, `pre-read-${kernelMode}.sh`);
  writeFileSync(
    hookScript,
    `#!/bin/sh\necho ran > "${marker}"\necho '{"decision":"allow"}'\n`,
    { mode: 0o755 },
  );
  chmodSync(hookScript, 0o755);
  writeFileSync(
    path.join(hooksDir, "hooks.json"),
    JSON.stringify({
      hooks: [{ event: "tool.pre", matcher: "read", command: hookScript }],
    }),
  );

  writeFileSync(path.join(workspace, "a.txt"), "hello\n");

  let phase = 0;
  const provider: Provider = {
    name: "scripted",
    async *stream(): AsyncGenerator<ProviderEvent> {
      phase += 1;
      if (phase === 1) {
        yield {
          type: "tool_call",
          id: "call_read",
          name: "read",
          arguments: JSON.stringify({ path: "a.txt" }),
        } satisfies ProviderEvent;
        yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };

  const stateDir = path.join(workspaceStateDir(workspace), "kernel");
  mkdirSync(stateDir, { recursive: true });
  const kernel = new KernelClient({ workspace, stateDir });
  const store = new SessionStore(workspace);
  const notices: string[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession(`hooks-${kernelMode}`).id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: {
      onEvent: (ev) => {
        if (ev.type === "notice" && typeof (ev as { message?: string }).message === "string") {
          notices.push((ev as { message: string }).message);
        }
      },
    },
    sessionLeases: [],
    approve: async () => true,
    hooks: loadHooks(workspace, { home, trustWorkspaceHooks: true }),
    trustedWorkspaceHooks: [path.resolve(workspace)],
  };

  try {
    await runTurn(deps);
  } finally {
    await kernel.close().catch(() => undefined);
    store.close();
  }

  expect(existsSync(marker)).toBe(false);
  expect(notices.some((n) => n.includes(notice))).toBe(true);
}

describe("effect-host hooks suppress (rulings 651 + 666)", () => {
  test("preTool hook on read is not spawned under require", async () => {
    await expectHookNotSpawnedUnderEffectHost("require", EFFECT_HOST_KERNEL_REQUIRE_HOOKS_SUPPRESSED_NOTICE);
  }, 30_000);

  test("preTool hook on read is not spawned under default", async () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    await expectHookNotSpawnedUnderEffectHost("default", EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE);
  }, 30_000);

  test("preTool hook on read is not spawned under =1", async () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
    await expectHookNotSpawnedUnderEffectHost("opt-in", EFFECT_HOST_KERNEL_ON_HOOKS_SUPPRESSED_NOTICE);
  }, 30_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore } from "../../src/core/session";
import { KernelClient, LocalKernel } from "../../src/core/kernel";
import {
  effectHostKernelRequirePreflight,
  effectHostKernelRequireRefusal,
  effectHostNoAmbientToolPreflight,
} from "../../src/core/effect-host-posture";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-r170-barrier-"));
  tempDirs.push(dir);
  return dir;
}

const savedBarrierEnv = process.env.HZ_R170_SQLITE_BARRIER;
const savedEffectHostEnv = process.env.HZ_EFFECT_HOST_KERNEL;
const savedCodeModeEnv = process.env.HZ_CODEMODE_EFFECT_HOST;

afterEach(() => {
  if (savedBarrierEnv === undefined) delete process.env.HZ_R170_SQLITE_BARRIER;
  else process.env.HZ_R170_SQLITE_BARRIER = savedBarrierEnv;

  if (savedEffectHostEnv === undefined) delete process.env.HZ_EFFECT_HOST_KERNEL;
  else process.env.HZ_EFFECT_HOST_KERNEL = savedEffectHostEnv;

  if (savedCodeModeEnv === undefined) delete process.env.HZ_CODEMODE_EFFECT_HOST;
  else process.env.HZ_CODEMODE_EFFECT_HOST = savedCodeModeEnv;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("R170 SQLite mutation barrier (SessionStore)", () => {
  test("refuses SQLite mutations when HZ_R170_SQLITE_BARRIER=1 and barrier is blocked, and resumes once cleared", () => {
    const workspace = makeTempWorkspace();
    const store = new SessionStore(workspace);
    try {
      let latched = false;
      let unresolvedIds: string[] = [];
      store.setReconcileBarrierCheck(() => ({ blocked: latched, unresolvedIds }));

      // Create an initial session while unlatched.
      process.env.HZ_R170_SQLITE_BARRIER = "1";
      const session = store.createSession("Initial");
      store.appendMessage(session.id, { role: "user", content: "hello" });
      expect(store.history(session.id).length).toBe(1);

      // Latch UNKNOWN barrier.
      latched = true;
      unresolvedIds = ["eff_unknown_01"];

      expect(() => store.createSession("Blocked")).toThrow(/HZ_R170_LATCH_BLOCKED/);
      expect(() => store.createSession("Blocked")).toThrow(/eff_unknown_01/);
      expect(() =>
        store.appendMessage(session.id, { role: "assistant", content: "blocked reply" }),
      ).toThrow(/HZ_R170_LATCH_BLOCKED/);
      expect(() => store.touchSession(session.id, "Retitled")).toThrow(/HZ_R170_LATCH_BLOCKED/);
      expect(() => store.forkSession(session.id)).toThrow(/HZ_R170_LATCH_BLOCKED/);
      expect(() => store.truncateMessages(session.id, 0)).toThrow(/HZ_R170_LATCH_BLOCKED/);

      // Read operations remain available while latched.
      expect(store.getSession(session.id)?.title).toBe("Initial");
      expect(store.history(session.id).length).toBe(1);

      // Clear the latch and confirm mutations resume.
      latched = false;
      unresolvedIds = [];

      const second = store.createSession("Resumed");
      expect(second.title).toBe("Resumed");
      store.appendMessage(session.id, { role: "assistant", content: "resumed reply" });
      expect(store.history(session.id).length).toBe(2);
      store.touchSession(session.id, "Initial Updated");
      expect(store.getSession(session.id)?.title).toBe("Initial Updated");
    } finally {
      store.close();
    }
  });

  test("does not block SQLite mutations when HZ_R170_SQLITE_BARRIER is unset", () => {
    const workspace = makeTempWorkspace();
    const store = new SessionStore(workspace);
    try {
      delete process.env.HZ_R170_SQLITE_BARRIER;
      store.setReconcileBarrierCheck(() => ({ blocked: true, unresolvedIds: ["eff_ignored"] }));

      const session = store.createSession("Allowed when env unset");
      store.appendMessage(session.id, { role: "user", content: "still works" });
      expect(store.history(session.id).length).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("R170 reconcile.gate client method", () => {
  test("LocalKernel.checkReconcileBarrier() returns unblocked empty status", async () => {
    const workspace = makeTempWorkspace();
    const stateDir = path.join(workspace, ".hz", "state", "kernel");
    const local = new LocalKernel({ stateDir });
    try {
      const status = await local.checkReconcileBarrier();
      expect(status).toEqual({ blocked: false, unresolvedCount: 0, unresolvedIds: [] });
    } finally {
      await local.close();
    }
  });

  test("KernelClient.checkReconcileBarrier() falls back cleanly when untrusted", async () => {
    const workspace = makeTempWorkspace();
    const client = new KernelClient({ workspace });
    try {
      const status = await client.checkReconcileBarrier();
      expect(status).toEqual({ blocked: false, unresolvedCount: 0, unresolvedIds: [] });
    } finally {
      await client.close();
    }
  });
});

describe("Code Mode + EffectHost seam (HZ_CODEMODE_EFFECT_HOST)", () => {
  test("effectHostNoAmbientToolPreflight refuses code_mode by default and admits when HZ_CODEMODE_EFFECT_HOST=1", () => {
    delete process.env.HZ_CODEMODE_EFFECT_HOST;

    const refusedDefault = effectHostNoAmbientToolPreflight("code_mode", {
      HZ_EFFECT_HOST_KERNEL: "default",
    });
    expect(refusedDefault).toBeDefined();
    expect(refusedDefault).toContain("code_mode");

    const refusedOptIn = effectHostNoAmbientToolPreflight("code_mode", {
      HZ_EFFECT_HOST_KERNEL: "1",
    });
    expect(refusedOptIn).toBeDefined();
    expect(refusedOptIn).toContain("code_mode");

    const admittedDefault = effectHostNoAmbientToolPreflight("code_mode", {
      HZ_EFFECT_HOST_KERNEL: "default",
      HZ_CODEMODE_EFFECT_HOST: "1",
    });
    expect(admittedDefault).toBeUndefined();

    const admittedOptIn = effectHostNoAmbientToolPreflight("code_mode", {
      HZ_EFFECT_HOST_KERNEL: "1",
      HZ_CODEMODE_EFFECT_HOST: "1",
    });
    expect(admittedOptIn).toBeUndefined();
  });

  test("effectHostKernelRequirePreflight and effectHostKernelRequireRefusal refuse code_mode by default and admit when HZ_CODEMODE_EFFECT_HOST=1", () => {
    process.env.HZ_EFFECT_HOST_KERNEL = "require";
    delete process.env.HZ_CODEMODE_EFFECT_HOST;

    const preflightRefused = effectHostKernelRequirePreflight("code_mode", {});
    expect(preflightRefused).toBeDefined();
    expect(preflightRefused).toContain("code_mode");

    const postflightRefused = effectHostKernelRequireRefusal("code_mode", {}, false);
    expect(postflightRefused).toBeDefined();
    expect(postflightRefused).toContain("code_mode");

    process.env.HZ_CODEMODE_EFFECT_HOST = "1";
    expect(effectHostKernelRequirePreflight("code_mode", {})).toBeUndefined();
    expect(effectHostKernelRequireRefusal("code_mode", {}, false)).toBeUndefined();
  });
});

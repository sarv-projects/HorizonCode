/**
 * P0-3 reduced Bun write/edit workspace fence — not full R170.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  BUN_MUTATION_R170_LOCK_TARGET,
  effectR170BunMutationFenceEnabled,
  effectR170BunMutationLockPath,
  formatEffectR170BunFenceLockTimeout,
  withEffectR170BunMutationFence,
} from "../../src/core/effect-r170-bun-mutation-fence";
import { acquireLockSync, LockTimeoutError, targetLockPath } from "../../src/core/file-lock";
import { writeTool } from "../../src/tools/write";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

const WORKER = path.join(import.meta.dir, "fixtures", "r170-bun-fence-worker.ts");

const roots: string[] = [];
function workspaceRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-r170-bun-fence-"));
  roots.push(dir);
  mkdirSync(path.join(dir, ".hz", "state"), { recursive: true });
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("effect-r170-bun-mutation-fence — enablement", () => {
  let snap: EnvSnapshot;
  afterAll(() => restoreEnv(snap));

  test("off when spine and explicit flag are unset", () => {
    snap = snapshotEnv();
    setEnv({ HZ_EFFECT_R170_BUN: undefined, HZ_EFFECT_HOST_KERNEL: "0" });
    expect(effectR170BunMutationFenceEnabled()).toBe(false);
  });

  test("on for HZ_EFFECT_R170_BUN=1", () => {
    setEnv({ HZ_EFFECT_R170_BUN: "1", HZ_EFFECT_HOST_KERNEL: "0" });
    expect(effectR170BunMutationFenceEnabled()).toBe(true);
  });

  test("on when EffectHost kernel spine active", () => {
    setEnv({ HZ_EFFECT_R170_BUN: undefined, HZ_EFFECT_HOST_KERNEL: "default" });
    expect(effectR170BunMutationFenceEnabled()).toBe(true);
  });

  test("explicit HZ_EFFECT_R170_BUN=0 disables even if spine on", () => {
    setEnv({ HZ_EFFECT_R170_BUN: "0", HZ_EFFECT_HOST_KERNEL: "require" });
    expect(effectR170BunMutationFenceEnabled()).toBe(false);
  });
});

describe("effect-r170-bun-mutation-fence — lock path and acquire/release", () => {
  test("uses workspace state locks dir with stable target key", () => {
    const ws = workspaceRoot();
    const lock = effectR170BunMutationLockPath(ws);
    expect(lock).toBe(targetLockPath(ws, BUN_MUTATION_R170_LOCK_TARGET));
    expect(lock).toContain(`${path.sep}locks${path.sep}`);
  });

  test("withEffectR170BunMutationFence is no-op when disabled", async () => {
    const ws = workspaceRoot();
    const snap = snapshotEnv();
    setEnv({ HZ_EFFECT_R170_BUN: undefined, HZ_EFFECT_HOST_KERNEL: "0" });
    let ran = false;
    await withEffectR170BunMutationFence(ws, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(effectR170BunMutationLockPath(ws))).toBe(false);
    restoreEnv(snap);
  });

  test("acquires and releases workspace lock when enabled", async () => {
    const ws = workspaceRoot();
    const snap = snapshotEnv();
    setEnv({ HZ_EFFECT_R170_BUN: "1", HZ_EFFECT_HOST_KERNEL: "0" });
    const lock = effectR170BunMutationLockPath(ws);
    await withEffectR170BunMutationFence(ws, async () => {
      expect(existsSync(lock)).toBe(true);
    });
    expect(existsSync(lock)).toBe(false);
    restoreEnv(snap);
  });

  test("timeout fails closed with HZ_PRECONDITION_FAILED", async () => {
    const ws = workspaceRoot();
    const snap = snapshotEnv();
    setEnv({
      HZ_EFFECT_R170_BUN: "1",
      HZ_EFFECT_HOST_KERNEL: "0",
      HZ_EFFECT_R170_BUN_TIMEOUT_MS: "80",
    });
    const lock = effectR170BunMutationLockPath(ws);
    const release = acquireLockSync(lock);
    let err: unknown;
    try {
      await withEffectR170BunMutationFence(ws, async () => undefined);
    } catch (e) {
      err = e;
    } finally {
      release();
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("HZ_PRECONDITION_FAILED: bun-mutation-r170 fence");
    expect(String(err)).toContain("MCP/hooks barrier OPEN");
    restoreEnv(snap);
  });

  test("formatEffectR170BunFenceLockTimeout names holder", () => {
    const msg = formatEffectR170BunFenceLockTimeout(
      new LockTimeoutError("/tmp/x.lock", 4242, 80),
    );
    expect(msg).toContain("4242");
    expect(msg).toContain("HZ_PRECONDITION_FAILED");
  });
});

describe("effect-r170-bun-mutation-fence — write tool serialization", () => {
  test("two processes cannot interleave write when fence held", async () => {
    const ws = workspaceRoot();
    const snap = snapshotEnv();
    setEnv({ HZ_EFFECT_R170_BUN: "1", HZ_EFFECT_HOST_KERNEL: "0", HZ_EFFECT_R170_BUN_TIMEOUT_MS: "150" });
    const target = path.join(ws, "contended.txt");
    writeFileSync(target, "seed\n");

    const holder = Bun.spawn(["bun", WORKER, "hold", ws, "800"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const heldMarker = path.join(ws, ".fence-held");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (existsSync(heldMarker)) break;
      await Bun.sleep(25);
    }
    expect(existsSync(heldMarker)).toBe(true);

    const ctx = {
      cwd: ws,
      workspace: ws,
      sessionId: "parent",
      signal: new AbortController().signal,
      guard: async () => ({ decision: "allow" as const }),
      approve: async () => true,
      receipt: async () => ({}) as never,
    };
    const result = await writeTool.execute({ path: target, content: "parent\n", force: true }, ctx as never);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bun-mutation-r170 fence");

    const childOut = await new Response(holder.stdout).text();
    await holder.exited;
    expect(childOut).toContain('"ok":true');
    expect(readFileSync(target, "utf8")).toBe("seed\n");

    restoreEnv(snap);
  });
});
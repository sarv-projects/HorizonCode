/** Trusted-kernel OwnerLog: cross-process R170 partial and TS transport fail-close. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
import { tryKernelWriteRoute, tryKernelShellRoute } from "../../src/core/effect-kernel-mutation-route";
import { hasRustKernel, restoreEnv, rustKernelPath, setEnv, snapshotEnv } from "./helpers";

describe("kernel-owned OwnerLog admission (R170 partial)", () => {
  test.skipIf(!hasRustKernel)("two independent trusted clients see durable UNKNOWN and refuse next write", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-dual-"));
    const state = path.join(root, ".hzcode", "kernel");
    const file = path.join(root, "source.txt");
    writeFileSync(file, "before");
    const first = new KernelClient({ workspace: root, stateDir: state });
    const second = new KernelClient({ workspace: root, stateDir: state });
    try {
      expect(await first.start()).toBe("trusted");
      expect(await second.start()).toBe("trusted");
      const landed = await first.executeEffect({
        effectId: "owner-write-1", sandboxRoot: root,
        dispatch: { kind: "fs.write", spec: { path: "source.txt", text: "after" } },
      });
      expect(landed.ownerLogSettled).toBe(true);
      expect(landed.ownerReceiptId).toBeDefined();
      expect(landed.ownerResultDigest).toBe(landed.resultDigest);
      expect(readFileSync(file, "utf8")).toBe("after");
      expect((await second.ownerVerify()).ok).toBe(true);
      expect((await second.ownerStatus()).unresolved).toBe(0);

      await expect(first.executeEffect({
        effectId: "owner-invalid-edit", sandboxRoot: root,
        dispatch: { kind: "fs.edit", spec: {
          path: "source.txt", oldString: "not there", newString: "WRONG",
        } },
      })).rejects.toThrow(/oldString/);
      expect((await second.ownerStatus()).blocked).toBe(true);
      await expect(second.executeEffect({
        effectId: "owner-write-2", sandboxRoot: root,
        dispatch: { kind: "fs.write", spec: { path: "source.txt", text: "WRONG" } },
      })).rejects.toThrow(/OwnerLog UNKNOWN/);
      expect(readFileSync(file, "utf8")).toBe("after");
      expect((await first.ownerVerify()).unresolved).toBe(1);
    } finally {
      await first.close();
      await second.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test.skipIf(!hasRustKernel)("concurrent separate kernels serialise distinct admitted mutations", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-par-"));
    const state = path.join(root, ".hzcode", "kernel");
    const first = new KernelClient({ workspace: root, stateDir: state });
    const second = new KernelClient({ workspace: root, stateDir: state });
    try {
      expect(await first.start()).toBe("trusted");
      expect(await second.start()).toBe("trusted");
      const results = await Promise.all([
        first.executeEffect({ effectId: "parallel-a", sandboxRoot: root,
          dispatch: { kind: "fs.write", spec: { path: "a.txt", text: "A" } } }),
        second.executeEffect({ effectId: "parallel-b", sandboxRoot: root,
          dispatch: { kind: "fs.write", spec: { path: "b.txt", text: "B" } } }),
      ]);
      expect(results.every((r) => r.ownerLogSettled)).toBe(true);
      expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("A");
      expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("B");
      expect((await first.ownerStatus()).events).toBe(6);
      await expect(second.ownerRecover("parallel-a")).rejects.toThrow(/execution may have started/);
      expect((await second.ownerVerify()).receiptsVerified).toBe(2);
    } finally {
      await first.close();
      await second.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test.skipIf(!hasRustKernel)("an authoritative Rust refusal never becomes ambient Bun fallback under default", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_EFFECT_HOST_KERNEL: "default" });
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-no-downgrade-"));
    const client = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await client.start()).toBe("trusted");
      const deniedShell = await tryKernelShellRoute(client, root, "shell-printf", { command: "printf hello" });
      expect(deniedShell?.result.ok).toBe(false);
      expect(deniedShell?.result.error).toContain("unconfined shell.exec");
      // Force an UNKNOWN on a failed mutation, then attempt a different file.
      await expect(client.executeEffect({
        effectId: "failed-edit", sandboxRoot: root,
        dispatch: { kind: "fs.edit", spec: { path: "missing.txt", oldString: "x", newString: "y" } },
      })).rejects.toThrow(/existing file/);
      const routed = await tryKernelWriteRoute(client, root, "s-no-downgrade", "after-unknown", {
        path: "denied.txt", content: "WRONG",
      });
      expect(routed?.result.ok).toBe(false);
      expect(routed?.result.error).toContain("OwnerLog UNKNOWN");
      const guard = await client.checkGuard({ kind: "fs.write", target: path.join(root, "denied.txt") }, "workspace");
      expect(guard.decision).toBe("deny");
      expect(guard.reason).toContain("OwnerLog");
      expect(() => readFileSync(path.join(root, "denied.txt"))).toThrow();
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test.skipIf(!hasRustKernel)("lost kernel response after executing never replays in LocalKernel", async () => {
    const snapshot = snapshotEnv();
    setEnv({
      HZ_KERNEL_BIN: rustKernelPath,
      HZ_EFFECT_HOST_KERNEL: "default",
      HZ_EFFECT_OWNER_FAULT_AFTER_EXECUTING: "1",
    });
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-no-transport-replay-"));
    const state = path.join(root, ".hzcode", "kernel");
    const client = new KernelClient({ workspace: root, stateDir: state });
    try {
      expect(await client.start()).toBe("trusted");
      const first = await tryKernelWriteRoute(client, root, "s-crash", "crashed", {
        path: "never.txt", content: "BAD",
      });
      expect(first?.result.ok).toBe(false);
      expect(first?.result.error).toMatch(/UNKNOWN|transport lost/);
      expect(() => readFileSync(path.join(root, "never.txt"))).toThrow();
      const second = await tryKernelWriteRoute(client, root, "s-crash", "after-crash", {
        path: "never.txt", content: "ALSO_BAD",
      });
      expect(second?.result.ok).toBe(false);
      expect(second?.result.error).toMatch(/UNKNOWN|trusted kernel was lost/);
      expect(() => readFileSync(path.join(root, "never.txt"))).toThrow();

      setEnv({ HZ_EFFECT_OWNER_FAULT_AFTER_EXECUTING: undefined });
      const restarted = new KernelClient({ workspace: root, stateDir: state });
      try {
        expect(await restarted.start()).toBe("trusted");
        expect((await restarted.ownerStatus()).blocked).toBe(true);
        await expect(restarted.ownerRecover("crashed")).rejects.toThrow(/execution may have started/);
      } finally {
        await restarted.close();
      }
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test("untrusted transport refuses to assert Rust OwnerLog status or receipt verification", async () => {
    const snapshot = snapshotEnv();
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-no-kernel-"));
    setEnv({ HZ_KERNEL_BIN: path.join(root, "nonexistent-hz-kernel") });
    const kernel = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await kernel.start()).toBe("untrusted");
      await expect(kernel.ownerStatus()).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.ownerVerify()).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.ownerRecover("anything")).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.appendEvent("owner:effects", {
        id: "forge", ts: new Date().toISOString(), stream: "owner:effects",
        type: "owner.settled", actor: { kind: "system", id: "forge" }, payload: {},
      })).rejects.toThrow(/owner event streams are kernel-only/);
    } finally {
      await kernel.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });
});

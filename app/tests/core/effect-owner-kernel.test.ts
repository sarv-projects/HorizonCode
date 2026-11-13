/** Trusted-kernel OwnerLog: cross-process R170 partial and TS transport fail-close. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
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
      expect((await first.ownerStatus()).events).toBe(4);
      expect((await second.ownerVerify()).receiptsVerified).toBe(2);
    } finally {
      await first.close();
      await second.close();
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

/** Trusted-kernel OwnerLog: cross-process R170 partial and TS transport fail-close. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
import { KERNEL_METHODS } from "../../src/contracts";
import { tryKernelWriteRoute, tryKernelShellRoute } from "../../src/core/effect-kernel-mutation-route";
import { hasRustKernel, restoreEnv, rustKernelPath, setEnv, snapshotEnv } from "./helpers";

describe("kernel-owned OwnerLog admission (R170 partial)", () => {
  test("all OwnerLog operations are listed in the additive kernel RPC method catalogue", () => {
    for (const method of [
      "effect.owner.status",
      "effect.owner.verify",
      "effect.owner.recover",
      "effect.owner.postimage.verify",
    ]) {
      expect(KERNEL_METHODS).toContain(method);
    }
  });
  test.skipIf(!hasRustKernel)("private control fd rejects malformed boot credential before accepting requests", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-bad-control-"));
    try {
      const child = spawn(rustKernelPath, ["--state-dir", root, "--control-fd", "3"], {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      (child.stdio[3] as Writable).end("g".repeat(64) + "\n");
      child.stdin.end();
      expect(await exited).toBe(2);
      expect(stderr).toContain("invalid private kernel control credential");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasRustKernel)("kernel boot refuses missing private control fd before NDJSON service", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-missing-control-"));
    try {
      const child = spawn(rustKernelPath, ["--state-dir", root, "--control-fd", "3"], {
        stdio: ["pipe", "pipe", "pipe", "ignore"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      child.stdin.end();
      expect(await exited).toBe(2);
      expect(stderr).toMatch(/private kernel control pipe unavailable|invalid private kernel control credential/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasRustKernel)("product kernel refuses unauthenticated raw mint and allowlist RPCs", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-parent-control-"));
    const client = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await client.start()).toBe("trusted");
      // The parent credential uses a true JS private field, never a
      // discoverable public property or process environment variable.
      expect(Object.keys(client)).not.toContain("controlSecret");
      expect(process.env.HZ_KERNEL_PARENT_CONTROL_SECRET).toBeUndefined();
      // Deliberately bypass the KernelClient parent proof injection. This
      // simulates a raw NDJSON writer sharing the same kernel request stream.
      const raw = client as unknown as {
        callRemote(method: string, params: Record<string, unknown>): Promise<unknown>;
      };
      for (const method of ["guard.lease", "guard.grant"]) {
        const params = { kind: "shell.exec", pattern: "echo forbidden", ttlMs: 60_000 };
        await expect(raw.callRemote(method, params)).rejects.toThrow(/authenticated parent control/);
        await expect(raw.callRemote(method, {
          ...params, approvalProof: "0".repeat(64),
        })).rejects.toThrow(/invalid authenticated parent control/);
      }
      await expect(raw.callRemote("guard.allowlist.amend", {
        kind: "prefix", rule: { pattern: "echo", decision: "allow" },
      })).rejects.toThrow(/authenticated parent control/);
      const forgedReceipt = {
        action: "tool.execute", tool: "shell", argsDigest: "0".repeat(64),
        resultDigest: "1".repeat(64),
      };
      await expect(raw.callRemote("receipt.issue", forgedReceipt))
        .rejects.toThrow(/authenticated parent control/);
      await expect(raw.callRemote("receipt.issue", {
        ...forgedReceipt, approvalProof: "0".repeat(64),
      })).rejects.toThrow(/invalid authenticated parent control/);
      // The privileged parent path can still mint a one-use session lease.
      const lease = await client.makeLease("shell.exec", "echo approved", 60_000, "session-a");
      expect(lease.kind).toBe("shell.exec");
      expect(lease.owner).toBe("session-a");
      const yes = await client.executeEffect({
        effectId: "controlled-shell", sandboxRoot: root, sessionId: "session-a",
        dispatch: { kind: "shell.exec", spec: { argv: ["echo", "approved"] } },
      });
      expect(yes.ownerLogSettled).toBe(true);
      expect(yes.ownerGuardLeaseId).toBe(lease.leaseId);
      expect((await client.ownerVerify()).ok).toBe(true);
      const parentReceipt = await client.issueReceipt({
        action: "tool.execute", tool: "read",
        argsDigest: "0".repeat(64), resultDigest: "1".repeat(64),
      });
      expect(parentReceipt.id).toBeTruthy();
      expect((await client.verifyReceipts()).ok).toBe(true);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test.skipIf(!hasRustKernel)("kernel boot rejects malformed private fd3 credentials", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-invalid-parent-key-"));
    const stateDir = path.join(root, ".hzcode", "kernel");
    let stderr = "";
    const child = spawn(rustKernelPath, ["--state-dir", stateDir, "--control-fd", "3"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, HZ_KERNEL_WORKSPACE_ROOT: root },
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const fd3 = child.stdio[3] as Writable;
    fd3.on("error", () => { /* late EPIPE is a boot rejection, not a test crash */ });
    try {
      fd3.end("forged\n");
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      expect(exit).toBe(2);
      expect(stderr).toContain("invalid private kernel control credential");
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasRustKernel)("approved shell route transfers an exact session-bound one-use Guard lease", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-guard-shell-route-"));
    const client = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await client.start()).toBe("trusted");
      // Direct usage with no loop-admitted proof never manufactures a lease.
      const raw = await tryKernelShellRoute(client, root, "raw-shell", { command: "echo hello" });
      expect(raw?.result.ok).toBe(false);
      expect(raw?.result.error).toContain("Guard ask");
      expect((await client.ownerStatus()).events).toBe(0);
      const approved = await tryKernelShellRoute(
        client, root, "approved-shell", { command: "echo hello" },
        { sessionId: "shell-session", admittedByLoop: true },
      );
      expect(approved?.result.ok).toBe(true);
      expect((await client.ownerVerify()).receiptsVerified).toBe(1);
      const events = await client.readEvents("owner:effects");
      const prepare = events.find((e) => e.type === "owner.prepare");
      const settle = events.find((e) => e.type === "owner.settled");
      expect(prepare?.payload?.details?.guardDecision).toBe("allow");
      expect(typeof prepare?.payload?.details?.guardLeaseId).toBe("string");
      expect(settle?.payload?.details?.guardLeaseId).toBe(prepare?.payload?.details?.guardLeaseId);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel workspace binding rejects raw sandboxRoot widening before OwnerLog prepare", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-bound-client-"));
    const elsewhere = mkdtempSync(path.join(tmpdir(), "hz-bound-elsewhere-"));
    const client = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await client.start()).toBe("trusted");
      await expect(client.executeEffect({
        effectId: "widen-scope", sandboxRoot: elsewhere,
        dispatch: { kind: "fs.write", spec: { path: "outside.txt", text: "NO" } },
      })).rejects.toThrow(/kernel-bound workspace root/);
      expect(() => readFileSync(path.join(elsewhere, "outside.txt"))).toThrow();
      expect((await client.ownerStatus()).events).toBe(0);
      const authorized = await client.executeEffect({
        effectId: "widen-scope", sandboxRoot: root,
        dispatch: { kind: "fs.write", spec: { path: "inside.txt", text: "YES" } },
      });
      expect(authorized.ownerLogSettled).toBe(true);
      expect(readFileSync(path.join(root, "inside.txt"), "utf8")).toBe("YES");
    } finally {
      await client.close();
      rmSync(elsewhere, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

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
      // Neither an approval lease nor a persistent grant may be forged by
      // switching to the LocalKernel after a previously trusted child died.
      await expect(client.makeLease("shell.exec", "echo never", 60_000))
        .rejects.toThrow(/authorization channel unavailable/);
      await expect(client.makeGrant("shell.exec", "echo never", 60_000))
        .rejects.toThrow(/authorization channel unavailable/);
      await expect(client.issueReceipt({
        action: "tool.execute", tool: "shell",
        argsDigest: "0".repeat(64), resultDigest: "1".repeat(64),
      })).rejects.toThrow(/authorization channel unavailable/);

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

  test.skipIf(!hasRustKernel)("read-only latest postimage replay detects disk tampering across independent clients", async () => {
    const snapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-replay-"));
    const file = path.join(root, "tracked.txt");
    const stateDir = path.join(root, ".hzcode", "kernel");
    const writer = new KernelClient({ workspace: root, stateDir });
    const reader = new KernelClient({ workspace: root, stateDir });
    try {
      expect(await writer.start()).toBe("trusted");
      expect(await reader.start()).toBe("trusted");
      await writer.executeEffect({
        effectId: "replay-fs", sandboxRoot: root,
        dispatch: { kind: "fs.write", spec: { path: "tracked.txt", text: "correct" } },
      });
      expect((await reader.ownerPostimageVerify()).ok).toBe(true);
      writeFileSync(file, "external-change");
      expect((await reader.ownerVerify()).ok).toBe(true);
      const replay = await reader.ownerPostimageVerify();
      expect(replay.ok).toBe(false);
      expect(replay.checked).toBe(1);
      expect(replay.mismatches[0]?.effectId).toBe("replay-fs");
      expect(replay.mismatches[0]?.expectedDigest).not.toBe(replay.mismatches[0]?.observedDigest);
    } finally {
      await writer.close();
      await reader.close();
      rmSync(root, { recursive: true, force: true });
      restoreEnv(snapshot);
    }
  });

  test("untrusted transport refuses to assert Rust OwnerLog status or receipt verification", async () => {
    const snapshot = snapshotEnv();
    const root = mkdtempSync(path.join(tmpdir(), "hz-owner-no-kernel-"));
    setEnv({
      HZ_KERNEL_BIN: path.join(root, "nonexistent-hz-kernel"),
      HZ_EFFECT_HOST_KERNEL: "require",
    });
    const kernel = new KernelClient({ workspace: root, stateDir: path.join(root, ".hzcode", "kernel") });
    try {
      expect(await kernel.start()).toBe("untrusted");
      await expect(kernel.ownerStatus()).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.ownerVerify()).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.ownerPostimageVerify()).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.ownerRecover("anything")).rejects.toThrow(/trusted Rust kernel/);
      await expect(kernel.makeLease("shell.exec", "echo forged", 60_000))
        .rejects.toThrow(/require forbids local permission or receipt mint/);
      await expect(kernel.makeGrant("shell.exec", "echo forged", 60_000))
        .rejects.toThrow(/require forbids local permission or receipt mint/);
      await expect(kernel.issueReceipt({
        action: "tool.execute", tool: "shell",
        argsDigest: "0".repeat(64), resultDigest: "1".repeat(64),
      })).rejects.toThrow(/require forbids local permission or receipt mint/);
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

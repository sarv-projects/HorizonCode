import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { KernelClient, resolveKernelSocketPath } from "../../src/core/kernel";
import {
  clearKernelControlSecret,
  connectKernelSocket,
  isPidAlive,
  kernelControlSecretPath,
  kernelDetachLooksLive,
  readKernelBinarySeal,
  readKernelControlSecret,
  readKernelPid,
  readKernelSupervisorEpoch,
  resolveLiveSocketPath,
  waitForKernelSocket,
  writeKernelControlSecret,
} from "../../src/core/kernel-socket";
import { existsSync } from "node:fs";
import {
  cleanupTemps,
  hasRustKernel,
  restoreEnv,
  rustKernelPath,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
} from "./helpers";

const kernelBin = rustKernelPath;

describe("kernel-socket helpers", () => {
  test("hzk.control seal round-trip (ruling 632)", () => {
    const dir = tempDir("hz-sock-ctrl-");
    mkdirSync(dir, { recursive: true });
    const secret = "ab".repeat(32);
    writeKernelControlSecret(dir, secret);
    expect(existsSync(kernelControlSecretPath(dir))).toBe(true);
    expect(readKernelControlSecret(dir)).toBe(secret);
    clearKernelControlSecret(dir);
    expect(readKernelControlSecret(dir)).toBeUndefined();
  });

  test("readKernelPid / isPidAlive round-trip on self", () => {
    const dir = tempDir("hz-sock-pid-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hzk.pid"), `${process.pid}\n`);
    expect(readKernelPid(dir)).toBe(process.pid);
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_000_000)).toBe(false);
  });

  test("resolveLiveSocketPath prefers hzk.socket record", () => {
    const dir = tempDir("hz-sock-live-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hzk.socket"), "/tmp/recorded.sock\n");
    expect(resolveLiveSocketPath(dir, "/tmp/fallback.sock")).toBe("/tmp/recorded.sock");
  });

  test("kernelDetachLooksLive requires pid + socket", () => {
    const dir = tempDir("hz-sock-live2-");
    mkdirSync(dir, { recursive: true });
    expect(kernelDetachLooksLive(dir)).toBe(false);
    writeFileSync(path.join(dir, "hzk.pid"), `${process.pid}\n`);
    expect(kernelDetachLooksLive(dir, path.join(dir, "missing.sock"))).toBe(false);
    const sock = path.join(dir, "hzk.sock");
    writeFileSync(sock, "");
    writeFileSync(path.join(dir, "hzk.socket"), `${sock}\n`);
    expect(kernelDetachLooksLive(dir, sock)).toBe(true);
  });
});

describe.skipIf(!hasRustKernel)("KernelClient H-29 detach reattach (ruling 628)", () => {
  const envBackup: EnvSnapshot = snapshotEnv();
  const leftovers: Array<() => void> = [];

  afterAll(() => {
    for (const stop of leftovers) stop();
    // Always clear detach env even if snapshot missed them (helpers ENV_KEYS).
    delete process.env.HZ_KERNEL_DETACH;
    delete process.env.HZ_KERNEL_SOCKET;
    restoreEnv(envBackup);
    cleanupTemps();
  });

  test("spawn with HZ_KERNEL_DETACH leaves orphan; second client reattaches via socket", async () => {
    const workspace = tempDir("hz-ws-detach-");
    const stateDir = path.join(tempDir("hz-state-detach-"), "kernel");
    mkdirSync(stateDir, { recursive: true });
    const socketPath = path.join(stateDir, "hzk.sock");
    setEnv({
      HZ_KERNEL_BIN: kernelBin,
      HZ_KERNEL_DETACH: "1",
      HZ_KERNEL_SOCKET: socketPath,
      HZ_STATE_DIR: undefined,
    });
    expect(resolveKernelSocketPath(process.env, stateDir)).toBe(socketPath);

    const first = new KernelClient({ workspace, stateDir });
    const mode1 = await first.start();
    expect(mode1).toBe("trusted");
    expect(first.modeReason).toMatch(/socket|reattached/);
    await first.close(); // detachSurvive → orphan keeps listening

    expect(await waitForKernelSocket(socketPath, 2_000)).toBe(true);
    const pid = readKernelPid(stateDir);
    expect(pid).toBeDefined();
    expect(isPidAlive(pid!)).toBe(true);
    leftovers.push(() => {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    });

    expect(readKernelControlSecret(stateDir)?.length).toBe(64);
    const epoch1 = readKernelSupervisorEpoch(stateDir);
    expect(epoch1).toBeDefined();
    expect(epoch1!).toBeGreaterThan(0);
    const binarySeal = readKernelBinarySeal(stateDir);
    expect(binarySeal?.length).toBe(64);

    const second = new KernelClient({ workspace, stateDir });
    expect(await second.start()).toBe("trusted");
    expect(second.modeReason).toContain("reattached");
    expect(second.modeReason).toContain("control remint restored");
    expect(second.modeReason).toContain(`epoch=${epoch1}`);
    const pong = await second.ping();
    expect(pong.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pong.supervisorEpoch).toBe(epoch1);
    expect(pong.supervisorBinarySha256).toBe(binarySeal);
    // Ruling 632: remint works after reattach with sealed control secret.
    const lease = await second.makeLease("fs.write", "workspace/**", 5_000, "s-reattach-ctrl");
    expect(lease.leaseId).toMatch(/\S/);
  await second.close();
    // Release cross-state host supervisor flock (703) before later cases.
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 30_000);

  test("reattach refuses tampered hzk.binary seal", async () => {
    const workspace = tempDir("hz-ws-bin-mis-");
    const stateDir = path.join(tempDir("hz-state-bin-mis-"), "kernel");
    mkdirSync(stateDir, { recursive: true });
    const socketPath = path.join(stateDir, "hzk.sock");
    setEnv({
      HZ_KERNEL_BIN: kernelBin,
      HZ_KERNEL_DETACH: "1",
      HZ_KERNEL_SOCKET: socketPath,
    });
    const first = new KernelClient({ workspace, stateDir });
    expect(await first.start()).toBe("trusted");
    await first.close();
    writeFileSync(path.join(stateDir, "hzk.binary"), `${"0".repeat(64)}\n`);
    const second = new KernelClient({ workspace, stateDir });
    const mode = await second.start();
    expect(mode).not.toBe("trusted");
    expect(second.modeReason).toMatch(/supervisor\.binary|reattach failed|start failed/i);
    const pid = readKernelPid(stateDir);
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await second.close();
  }, 30_000);

  test("connectKernelSocket answers ping against a standalone --socket kernel", async () => {
    const stateDir = path.join(tempDir("hz-state-sock-alone-"), "kernel");
    mkdirSync(stateDir, { recursive: true });
    const socketPath = path.join(stateDir, "hzk.sock");
    const child = spawn(
      kernelBin,
      ["--state-dir", stateDir, "--socket", socketPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    leftovers.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    });
    expect(await waitForKernelSocket(socketPath, 5_000)).toBe(true);
    const sock = await connectKernelSocket(socketPath);
    const reply = await new Promise<string>((resolve, reject) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += String(chunk);
        if (buf.includes("\n")) {
          resolve(buf);
          sock.end();
        }
      });
      sock.on("error", reject);
      sock.write(`{"id":9,"method":"ping","params":{}}\n`);
    });
    expect(reply).toContain('"id":9');
    expect(reply).toContain("version");
  }, 20_000);
});

import { describe, expect, test } from "bun:test";
import { checkKernelDetachPeerHonesty, type DoctorEnv } from "../../src/core/doctor";
import {
  kernelDetachEnvRequested,
  kernelDetachPeerHonesty,
} from "../../src/core/kernel-detach-peer-honesty";
import { resolveKernelSocketPath } from "../../src/core/kernel";

describe("kernelDetachPeerHonesty (H-29 / ruling 696)", () => {
  test("native win32 never claims peer check", () => {
    const h = kernelDetachPeerHonesty("win32");
    expect(h.peerCheckOnAccept).toBe(false);
    expect(h.socketServeAvailable).toBe(false);
    expect(h.detail).toContain("Unix-only");
  });

  test("linux claims SO_PEERCRED posture", () => {
    const h = kernelDetachPeerHonesty("linux");
    expect(h.peerCheckOnAccept).toBe(true);
    expect(h.socketServeAvailable).toBe(true);
  });

  test("resolveKernelSocketPath ignores detach on win32", () => {
    expect(
      resolveKernelSocketPath({ HZ_KERNEL_DETACH: "1" }, "/tmp/state", "win32"),
    ).toBeUndefined();
    expect(
      resolveKernelSocketPath({ HZ_KERNEL_SOCKET: "/tmp/x.sock" }, "/tmp/state", "win32"),
    ).toBeUndefined();
  });

  test("kernelDetachEnvRequested detects socket + detach", () => {
    expect(kernelDetachEnvRequested({})).toBe(false);
    expect(kernelDetachEnvRequested({ HZ_KERNEL_DETACH: "1" })).toBe(true);
    expect(kernelDetachEnvRequested({ HZ_KERNEL_SOCKET: "/x" })).toBe(true);
  });

  test("doctor fails closed when win32 requests detach", () => {
    const d: DoctorEnv = {
      env: { HZ_KERNEL_DETACH: "1" },
      workspace: "/ws",
      home: "/home",
      bunVersion: "1.0.0",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
      kernelBinary: undefined,
      platform: "win32",
    };
    const check = checkKernelDetachPeerHonesty(d);
    expect(check.status).toBe("fail");
    expect(check.id).toBe("kernel.detach.peer");
  });
});
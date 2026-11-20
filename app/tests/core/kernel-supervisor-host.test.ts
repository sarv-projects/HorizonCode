import { describe, expect, test } from "bun:test";
import {
  hostSupervisorLeaseHonesty,
  kernelSupervisorHostDetachFailsClosed,
  resolveHostSupervisorLockPath,
} from "../../src/core/kernel-supervisor-host";

describe("hostSupervisorLeaseHonesty (ruling 703 / 724)", () => {
  test("prefers XDG_RUNTIME_DIR/horizon/hzk.host.lock", () => {
    expect(resolveHostSupervisorLockPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe(
      "/run/user/1000/horizon/hzk.host.lock",
    );
  });

  test("linux reports unix flock path", () => {
    const h = hostSupervisorLeaseHonesty("linux", { XDG_RUNTIME_DIR: "/run/user/1" });
    expect(h.unixFlock).toBe(true);
    expect(h.crossProcessLock).toBe(true);
    expect(h.lockPath).toContain("hzk.host.lock");
    expect(h.detail).toContain("cross-state-dir");
  });

  test("win32 reports LockFileEx host lock", () => {
    const h = hostSupervisorLeaseHonesty("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(h.unixFlock).toBe(false);
    expect(h.windowsFileLock).toBe(true);
    expect(h.crossProcessLock).toBe(true);
    expect(h.lockPath).toContain("horizon");
    expect(h.detail).toMatch(/LockFileEx/);
  });

  test("detach fail-closed when cross-process lock unavailable", () => {
    expect(
      kernelSupervisorHostDetachFailsClosed("aix", { HZ_KERNEL_DETACH: "1" }),
    ).toBe(true);
    expect(kernelSupervisorHostDetachFailsClosed("win32", { HZ_KERNEL_DETACH: "1" })).toBe(false);
  });
});
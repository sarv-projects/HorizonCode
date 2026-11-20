/**
 * H-30 / CB-6 / ruling **703** + **724** — host-wide supervisor lease honesty.
 *
 * Mirrors `host_supervisor_lease.rs` lock path resolution for doctor / notices.
 */

import * as os from "node:os";
import * as path from "node:path";

export type HostSupervisorLeaseHonesty = {
  lockPath: string;
  /** Unix `flock` (kernel). */
  unixFlock: boolean;
  /** Windows `LockFileEx` (kernel). */
  windowsFileLock: boolean;
  /** Product may rely on cross-process supervisor exclusion when true. */
  crossProcessLock: boolean;
  detail: string;
};

export function resolveHostSupervisorLockPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (platform === "win32") {
    const local =
      typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim() !== ""
        ? env.LOCALAPPDATA.trim()
        : "";
    if (local !== "") {
      return path.join(local, "horizon", "hzk.host.lock");
    }
    const profile =
      typeof env.USERPROFILE === "string" && env.USERPROFILE.trim() !== ""
        ? env.USERPROFILE.trim()
        : typeof os.homedir === "function"
          ? os.homedir()
          : "";
    if (profile !== "") {
      return path.join(profile, "AppData", "Local", "horizon", "hzk.host.lock");
    }
    return path.join("horizon", "hzk.host.lock");
  }
  const xdg = typeof env.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR.trim() : "";
  if (xdg !== "") {
    return path.join(xdg, "horizon", "hzk.host.lock");
  }
  const home =
    typeof env.HOME === "string" && env.HOME.trim() !== ""
      ? env.HOME.trim()
      : typeof os.homedir === "function"
        ? os.homedir()
        : ".";
  return path.join(home, ".local", "share", "horizon", "hzk.host.lock");
}

export function hostSupervisorLeaseHonesty(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): HostSupervisorLeaseHonesty {
  const lockPath = resolveHostSupervisorLockPath(env, platform);
  const unix = platform === "linux" || platform === "darwin" || platform === "freebsd" || platform === "openbsd";
  const win32 = platform === "win32";
  if (unix) {
    return {
      lockPath,
      unixFlock: true,
      windowsFileLock: false,
      crossProcessLock: true,
      detail: `${platform} — one live hz-kernel per UID via flock ${lockPath} (cross-state-dir; ruling 703)`,
    };
  }
  if (win32) {
    return {
      lockPath,
      unixFlock: false,
      windowsFileLock: true,
      crossProcessLock: true,
      detail: `win32 — one live hz-kernel per user via LockFileEx ${lockPath} (cross-state-dir; ruling 724)`,
    };
  }
  return {
    lockPath,
    unixFlock: false,
    windowsFileLock: false,
    crossProcessLock: false,
    detail: `${platform} — host-wide supervisor lock not implemented; cross-process lease OPEN`,
  };
}

/** Fail-closed doctor when detach env is set but host cannot prove cross-process lock. */
export function kernelSupervisorHostDetachFailsClosed(
  platform: string,
  env: Record<string, string | undefined>,
): boolean {
  const detach =
    env.HZ_KERNEL_DETACH === "1" ||
    (typeof env.HZ_KERNEL_SOCKET === "string" && env.HZ_KERNEL_SOCKET.trim() !== "");
  if (!detach) return false;
  return !hostSupervisorLeaseHonesty(platform, env).crossProcessLock;
}
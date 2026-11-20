/**
 * H-29 / C16 (partial) — detach socket peer-lease honesty (Wave-0 residual).
 *
 * Unix: kernel socket serve may apply SO_PEERCRED same-UID on accept (ruling **645**).
 * Native Windows: `--socket` is unavailable; never claim peer-proven detach lease.
 */

export type KernelDetachPeerHonesty = {
  platform: string;
  socketServeAvailable: boolean;
  peerCheckOnAccept: boolean;
  /** Short line for doctor / notices — never claims peer-proven lease on non-Unix. */
  detail: string;
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function kernelDetachEnvRequested(env: Record<string, string | undefined>): boolean {
  const socket = typeof env.HZ_KERNEL_SOCKET === "string" ? env.HZ_KERNEL_SOCKET.trim() : "";
  if (socket !== "") return true;
  const detach = typeof env.HZ_KERNEL_DETACH === "string" ? env.HZ_KERNEL_DETACH.trim().toLowerCase() : "";
  return TRUTHY.has(detach);
}

export function kernelDetachPeerHonesty(platform: string = process.platform): KernelDetachPeerHonesty {
  if (platform === "win32") {
    return {
      platform: "win32",
      socketServeAvailable: false,
      peerCheckOnAccept: false,
      detail:
        "native Windows — HZ_KERNEL_SOCKET / HZ_KERNEL_DETACH reattach is Unix-only (SO_PEERCRED); named-pipe peer auth is not implemented",
    };
  }
  if (platform === "linux" || platform === "darwin" || platform === "freebsd" || platform === "openbsd") {
    return {
      platform,
      socketServeAvailable: true,
      peerCheckOnAccept: true,
      detail: `${platform} — detach socket serve uses Unix domain socket + kernel SO_PEERCRED same-UID on accept (not a human principal)`,
    };
  }
  return {
    platform,
    socketServeAvailable: false,
    peerCheckOnAccept: false,
    detail: `${platform} — detach socket peer check not claimed; use Linux/macOS/WSL for H-29 socket serve`,
  };
}
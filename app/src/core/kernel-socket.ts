/**
 * H-29 / rulings 628–632 — Unix-socket helpers for durable kernel serve.
 *
 * Complements `HZ_KERNEL_SOCKET` / `HZ_KERNEL_DETACH` (625–626): wait for the
 * listener, connect NDJSON, and probe whether a prior `hzk.pid` is still alive.
 *
 * **632:** detach persists the launch control secret in mode-0600 `hzk.control`
 * under the kernel state dir so a later KernelClient can remint. Same-UID
 * filesystem readers are already inside the fd-3 threat boundary (352); this
 * does **not** authenticate a human principal.
 */

import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const CONTROL_SECRET_BYTES = 64;

function isControlSecret(value: string): boolean {
  return (
    value.length === CONTROL_SECRET_BYTES &&
    [...value].every((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
    })
  );
}

/** Path of the detach control-secret seal (`<stateDir>/hzk.control`). */
export function kernelControlSecretPath(stateDir: string): string {
  return path.join(stateDir, "hzk.control");
}

/** Persist launch control secret for H-29 reattach (mode 0600). */
export function writeKernelControlSecret(stateDir: string, secret: string): void {
  if (!isControlSecret(secret)) {
    throw new Error("HZ_PRECONDITION_FAILED: invalid kernel control secret for detach seal");
  }
  const file = kernelControlSecretPath(stateDir);
  writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

/** Read a previously sealed control secret, or undefined if absent/invalid. */
export function readKernelControlSecret(stateDir: string): string | undefined {
  const file = kernelControlSecretPath(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8").trim();
    return isControlSecret(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the detach control seal (non-detach close / kill orphan). */
export function clearKernelControlSecret(stateDir: string): void {
  try {
    unlinkSync(kernelControlSecretPath(stateDir));
  } catch {
    /* absent */
  }
}

/** Path of the detach supervisor epoch (`<stateDir>/hzk.epoch`). */
export function kernelSupervisorEpochPath(stateDir: string): string {
  return path.join(stateDir, "hzk.epoch");
}

/** Path of the detach release-binary seal (`<stateDir>/hzk.binary`). */
export function kernelBinarySealPath(stateDir: string): string {
  return path.join(stateDir, "hzk.binary");
}

function isSha256Hex(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]+$/.test(value);
}

/** Read on-disk H-30 release-binary seal, or undefined if absent/invalid. */
export function readKernelBinarySeal(stateDir: string): string | undefined {
  const file = kernelBinarySealPath(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8").trim();
    return isSha256Hex(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Read on-disk H-30 supervisor epoch, or undefined if absent/invalid. */
export function readKernelSupervisorEpoch(stateDir: string): number | undefined {
  const file = kernelSupervisorEpochPath(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Read `<stateDir>/hzk.pid` when present and parse a positive pid. */
export function readKernelPid(stateDir: string): number | undefined {
  const file = path.join(stateDir, "hzk.pid");
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True when `kill(pid, 0)` succeeds (process exists; may be zombie). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prefer the live path recorded in `<stateDir>/hzk.socket`, else `fallback`. */
export function resolveLiveSocketPath(stateDir: string, fallback?: string): string | undefined {
  const record = path.join(stateDir, "hzk.socket");
  if (existsSync(record)) {
    try {
      const logged = readFileSync(record, "utf8").trim();
      if (logged !== "") return logged;
    } catch {
      /* fall through */
    }
  }
  return fallback && fallback.trim() !== "" ? fallback.trim() : undefined;
}

/** Poll until the socket path exists (kernel bind completed) or timeout. */
export async function waitForKernelSocket(
  socketPath: string,
  timeoutMs: number = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return existsSync(socketPath);
}

/** Connect a Unix NDJSON client to `socketPath`. */
export function connectKernelSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onErr = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", onErr);
    socket.once("connect", () => {
      socket.removeListener("error", onErr);
      socket.setEncoding("utf8");
      resolve(socket);
    });
  });
}

/**
 * True when a detach-capable kernel appears live for `stateDir` (pid alive and
 * socket path present). Does not prove the listener accepts connections.
 */
export function kernelDetachLooksLive(stateDir: string, socketPath?: string): boolean {
  const pid = readKernelPid(stateDir);
  if (pid === undefined || !isPidAlive(pid)) return false;
  const livePath = resolveLiveSocketPath(stateDir, socketPath);
  return Boolean(livePath && existsSync(livePath));
}

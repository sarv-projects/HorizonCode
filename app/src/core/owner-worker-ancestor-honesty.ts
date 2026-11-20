/**
 * C-12 (partial) — owner/worker ancestor-proving honesty across host OSes.
 *
 * Linux: bounded `/proc/<pid>/stat` ppid walk (`workerIsDescendantOf`).
 * macOS: reduced `ps -o ppid=` walk only (TOCTOU / no startTicks coupling — partial).
 * Windows: no reduced prove path — never claim ancestor-proved.
 *
 * Never shell-net `enforced`. Full R170 cross-process atomicity remains OPEN.
 */

import { execFileSync } from "node:child_process";

/** Must match `owner-worker-spawn.ts` — kept here to avoid a circular import. */
const OWNER_WORKER_PIPE_ENV = "HZ_OWNER_WORKER_PIPE";

export type OwnerWorkerAncestorHonesty = {
  platform: string;
  /** When false, the product pipe must refuse before reserving work. */
  ancestorProvingAvailable: boolean;
  /** How ancestry is walked on this host, or why it is not. */
  method: "linux-proc" | "darwin-ps" | "unavailable";
  /** Short line for doctor / product notices — never claims full R170 or shell-net enforcement. */
  detail: string;
};

/** Read parent pid on macOS via `/bin/ps` (no shell). Injectable in tests. */
export function readDarwinPpid(
  pid: number,
  execPs: (argv: string[]) => string = (argv) =>
    execFileSync("/bin/ps", argv, { encoding: "utf8", timeout: 2000 }),
): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execPs(["-o", "ppid=", "-p", String(pid)]).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

export function ownerWorkerAncestorHonesty(platform: string = process.platform): OwnerWorkerAncestorHonesty {
  if (platform === "linux") {
    return {
      platform,
      ancestorProvingAvailable: true,
      method: "linux-proc",
      detail:
        "Linux — owner/worker handshake uses a bounded /proc ppid ancestor walk before FIFO reserve (full R170 cross-process atomicity still OPEN)",
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      ancestorProvingAvailable: true,
      method: "darwin-ps",
      detail:
        "macOS — reduced ps ppid ancestor walk only (no /proc startTicks lockstep; TOCTOU residual); never claim full R170 or Linux-grade ancestor proof",
    };
  }
  return {
    platform,
    ancestorProvingAvailable: false,
    method: "unavailable",
    detail:
      platform === "win32"
        ? "native Windows — owner/worker ancestor proving is unavailable (no reduced parent-walk); HZ_OWNER_WORKER_PIPE=1 will refuse before reserve"
        : `${platform} — owner/worker ancestor proving unavailable; use Linux or macOS (reduced) for C-12 pipe`,
  };
}

export function ownerWorkerPipeEnvRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OWNER_WORKER_PIPE_ENV] === "1";
}

/** Product turn preflight when the opt-in pipe gate is on. */
export function ownerWorkerTurnPreflight(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason?: string } {
  if (!ownerWorkerPipeEnvRequested(env)) return { ok: true };
  const h = ownerWorkerAncestorHonesty(platform);
  if (!h.ancestorProvingAvailable) return { ok: false, reason: h.detail };
  return { ok: true };
}

/** User-facing suffix for a successful handshake — names the prove method, not shell-net. */
export function ownerWorkerSuccessNotice(platform: string = process.platform, pid: number): string {
  const h = ownerWorkerAncestorHonesty(platform);
  const prove =
    h.method === "linux-proc"
      ? "Linux /proc ancestor-proved"
      : h.method === "darwin-ps"
        ? "macOS ps ancestor walk (reduced — partial C-12)"
        : "ancestor not proved";
  return `owner-worker pipe: worker pid ${pid} handshake ok (${prove}; FIFO reserved; full R170 still OPEN)`;
}
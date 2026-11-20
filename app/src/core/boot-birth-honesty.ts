/**
 * D-3 (partial) — boot-relative birth token honesty on non-Linux hosts.
 *
 * Linux: boot-id tokens when `/proc/stat` `btime` is available (ruling **473**).
 * macOS: reduced `ps` `lstart` + `sysctl kern.boottime` → legacy `<pid>@<startTicks>`
 * only (no `boot:<bootId>:` — never claim Linux boot-id birth on Darwin).
 * Windows: birth recording unavailable — spawn ledger `birthIdentity` may be null.
 *
 * **Still OPEN:** hermes-style monotonic create_time re-anchor when sleep-wake moves
 * clocks without a new boot anchor; full NTP/VM-resume parity on Darwin.
 *
 * Never shell-net `enforced`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Matches `worker-identity.ProcessFacts` — duplicated here to avoid a circular import. */
export interface DarwinProcessFacts {
  ppid: number;
  pgid: number;
  startTicks: number;
}

/** jiffies surrogate (100 Hz) for Darwin second-resolution lstart minus boottime. */
export const DARWIN_START_TICKS_HZ = 100;

export type BootBirthMethod = "linux-boot-id" | "darwin-lstart" | "unavailable";

export type BootBirthHonesty = {
  platform: string;
  /** When false, `recordIdentity` / spawn ledger birth is unavailable on this host. */
  birthRecordingAvailable: boolean;
  /** When true, `boot:<bootId>:<pid>@<startTicks>` may be minted (Linux `/proc` only). */
  bootIdTokensAvailable: boolean;
  method: BootBirthMethod;
  detail: string;
};

export interface DarwinBirthReaders {
  readBoottimeSec?: () => number | undefined;
  /** Returns trimmed `ps` output lines: ppid, pgid, lstart (injectable in tests). */
  readPs?: (
    pid: number,
  ) => { ppid: number; pgid: number; lstart: string } | undefined;
}

function defaultExecPs(pid: number, args: string[]): string {
  return execFileSync("/bin/ps", args, { encoding: "utf8", timeout: 2000 });
}

/** Kernel boot epoch seconds from `sysctl kern.boottime` (macOS / BSD). */
export function readDarwinBoottimeSec(
  sysctl: () => string = () =>
    execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 2000,
    }),
): number | undefined {
  try {
    const raw = sysctl();
    const m = /sec\s*=\s*(\d+)/.exec(raw);
    if (!m) return undefined;
    const sec = Number(m[1]);
    return Number.isInteger(sec) && sec > 0 ? sec : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `ps -o lstart=` wall-clock into epoch seconds (best-effort). */
export function parseDarwinLstartEpoch(lstart: string): number | undefined {
  const trimmed = lstart.trim();
  if (trimmed.length === 0) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  const sec = Math.floor(ms / 1000);
  return Number.isInteger(sec) && sec > 0 ? sec : undefined;
}

/**
 * Reduced macOS process facts: ppid/pgid from `ps`, startTicks = jiffies since
 * boot from lstart − kern.boottime (second resolution — weaker than Linux /proc).
 */
function linuxBootIdGateOpen(): boolean {
  try {
    const raw = readFileSync("/proc/stat", "utf8");
    const match = /^btime\s+(\d+)\s*$/m.exec(raw);
    if (!match) return false;
    const btime = Number(match[1]);
    return Number.isInteger(btime) && btime > 0;
  } catch {
    return false;
  }
}

export function readDarwinProcessFacts(
  pid: number,
  readers: DarwinBirthReaders = {},
): DarwinProcessFacts | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const ps =
    readers.readPs ??
    ((p) => {
      try {
        const ppidOut = defaultExecPs(p, ["-o", "ppid=", "-p", String(p)]).trim();
        const pgidOut = defaultExecPs(p, ["-o", "pgid=", "-p", String(p)]).trim();
        const lstartOut = defaultExecPs(p, ["-o", "lstart=", "-p", String(p)]).trim();
        const ppid = Number(ppidOut);
        const pgid = Number(pgidOut);
        if (!Number.isInteger(ppid) || ppid <= 0 || !Number.isInteger(pgid) || pgid <= 0) {
          return undefined;
        }
        if (lstartOut.length === 0) return undefined;
        return { ppid, pgid, lstart: lstartOut };
      } catch {
        return undefined;
      }
    });
  const row = ps(pid);
  if (row === undefined) return undefined;
  const bootSec = (readers.readBoottimeSec ?? readDarwinBoottimeSec)();
  if (bootSec === undefined) return undefined;
  const startSec = parseDarwinLstartEpoch(row.lstart);
  if (startSec === undefined || startSec < bootSec) return undefined;
  const deltaSec = startSec - bootSec;
  const startTicks = deltaSec * DARWIN_START_TICKS_HZ;
  if (!Number.isInteger(startTicks) || startTicks <= 0) return undefined;
  return { ppid: row.ppid, pgid: row.pgid, startTicks };
}

export function bootBirthHonesty(platform: string = process.platform): BootBirthHonesty {
  if (platform === "linux") {
    const bootId = linuxBootIdGateOpen();
    return {
      platform,
      birthRecordingAvailable: true,
      bootIdTokensAvailable: bootId,
      method: "linux-boot-id",
      detail: bootId
        ? "Linux — boot-id birth tokens when /proc/stat btime is available (ruling 473); monotonic sleep-wake re-anchor on WSL/host still a named residual"
        : "Linux — legacy pid@startTicks only (/proc stat without btime gate); boot-id tokens unavailable on this kernel view",
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      birthRecordingAvailable: true,
      bootIdTokensAvailable: false,
      method: "darwin-lstart",
      detail:
        "macOS — reduced ps lstart + kern.boottime jiffies only (no boot:<bootId>: tokens); NTP/sleep-wake monotonic re-anchor still OPEN",
    };
  }
  return {
    platform,
    birthRecordingAvailable: false,
    bootIdTokensAvailable: false,
    method: "unavailable",
    detail:
      platform === "win32"
        ? "native Windows — process birth recording unavailable (no /proc, no reduced path); spawn ledger birthIdentity may be null"
        : `${platform} — process birth recording unavailable; use Linux for boot-id tokens or macOS for reduced lstart births`,
  };
}

/** User-facing one-liner after spawn — names platform honesty, never boot-id on non-Linux. */
export function spawnBirthLedgerNotice(
  platform: string = process.platform,
  birthIdentity: string | null,
): string {
  const h = bootBirthHonesty(platform);
  if (birthIdentity === null) {
    return `spawn ledger: birth identity unavailable (${h.detail})`;
  }
  if (birthIdentity.startsWith("boot:")) {
    return `spawn ledger: boot-anchored birth token recorded (${h.method}; monotonic sleep-wake residual still OPEN on non-pure-Linux)`;
  }
  return `spawn ledger: legacy pid@startTicks recorded (${h.method} — no boot-id on this host; ${h.detail})`;
}
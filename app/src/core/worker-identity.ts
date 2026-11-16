/**
 * worker-identity.ts — "is this still the process I recorded?" (NF-071).
 *
 * The primitive behind "a worker proves identity before work is reserved": an
 * identity is `{pid, startTicks}` where `startTicks` is field 22 (starttime) of
 * /proc/<pid>/stat — the process's birth, measured in clock ticks since boot.
 * Verifying re-reads /proc and refuses when the pid has no entry or its
 * startTicks moved: a recycled pid (new process, same number) can never pass as
 * the original. Boot-relative ticks mean an NTP step or a VM clock adjustment
 * cannot make a live process look dead.
 *
 * Ruling 473 (D-3 reduced): when `/proc/stat` exposes `btime`, birth tokens are
 * boot-id anchored — `boot:<bootId>:<pid>@<startTicks>`. `bootId` prefers
 * `/proc/sys/kernel/random/boot_id` (stable within a kernel boot even when WSL
 * re-anchors `btime` after host sleep); falls back to the decimal `btime`
 * seconds when the UUID file is absent. Legacy `<pid>@<startTicks>` tokens
 * still parse and verify (ruling 22).
 *
 * What IS checked:
 *   - the pid exists in /proc at verification time, and
 *   - its starttime equals the recorded starttime (pid-reuse refusal), and
 *   - when a boot-id token was recorded, the current boot id still matches.
 *
 * What is NOT checked (the deferred half of the design, stated exactly):
 *   - the ancestor chain — that this process descended from the owner. There is
 *     no parent-walk here, no pidfd, no subreaper check.
 *   - who observed the identity: any same-user process can read /proc, so the
 *     record is evidence of *when a pid was born*, not of who recorded it.
 *   - PID-namespace / container translation: the pid must be resolvable in the
 *     caller's own /proc namespace.
 *   - zombie grace: an unreaped zombie still has a /proc entry with matching
 *     startTicks and passes. Its work is over by then, so the caller's own
 *     liveness bookkeeping (subprocess exited) is the authority there.
 *   - platforms without /proc: identity is unavailable, so recordIdentity
 *     returns undefined and verifyIdentity refuses.
 *   - macOS/Windows births; hermes-style monotonic create_time re-anchor when
 *     btime moves under sleep-wake without a new boot_id.
 *
 * Tick granularity: two processes born within the same tick (10 ms at USER_HZ
 * 100) share a startTicks value, so startTicks identifies a *birth event*, not
 * a unique process; combined with the pid it is the same check systemd and
 * psutil use.
 */

import { readFileSync } from "node:fs";

/** A process birth identity: the pid and its starttime in clock ticks. */
export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat (starttime), clock ticks since boot. */
  startTicks: number;
  /**
   * Boot-id anchor when `/proc/stat` `btime` was available at record time
   * (ruling 473). Absent on legacy ruling-22 identities and non-Linux hosts.
   */
  bootId?: string;
}

/** The /proc facts this module parses from one stat line. */
export interface ProcessFacts {
  ppid: number;
  /** Process-group id (field 5); equals pid for a detached child. */
  pgid: number;
  startTicks: number;
}

/** Injectable /proc readers for hermetic boot-anchor tests. */
export interface BootProcReaders {
  /** Full text of `/proc/stat`, or undefined when unavailable. */
  readStat?: () => string | undefined;
  /** Trimmed text of `/proc/sys/kernel/random/boot_id`, or undefined. */
  readBootId?: () => string | undefined;
}

/**
 * Parse /proc/<pid>/stat for pid, ppid or pgid and starttime.
 *
 * The comm field (field 2) is free text and may contain spaces, parentheses and
 * newlines, so the fields are read from AFTER THE LAST ')' — the same rule the
 * kernel's own tools use. Returns undefined when the pid has no entry (gone,
 * or no /proc on this platform), when the pid field disagrees with the
 * request, or when the numbers do not parse.
 */
export function readProcessFacts(pid: number): ProcessFacts | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return undefined;
  const pidField = Number(raw.slice(0, open).trim());
  if (!Number.isInteger(pidField) || pidField !== pid) return undefined;
  // After the last ')': fields[0] = state (field 3), so ppid is fields[1]
  // (field 4), pgrp is fields[2] (field 5) and starttime is fields[19] (22).
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return undefined;
  if (!Number.isInteger(startTicks) || startTicks <= 0) return undefined;
  return { ppid, pgid, startTicks };
}

function defaultReadStat(): string | undefined {
  try {
    return readFileSync("/proc/stat", "utf8");
  } catch {
    return undefined;
  }
}

function defaultReadBootId(): string | undefined {
  try {
    const text = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kernel boot time in seconds since the Unix epoch from `/proc/stat` `btime`.
 * Undefined when /proc is absent or the line cannot be parsed.
 */
export function readBootBtime(readers?: BootProcReaders): number | undefined {
  const raw = (readers?.readStat ?? defaultReadStat)();
  if (raw === undefined) return undefined;
  const match = /^btime\s+(\d+)\s*$/m.exec(raw);
  if (!match) return undefined;
  const btime = Number(match[1]);
  if (!Number.isInteger(btime) || btime <= 0) return undefined;
  return btime;
}

/**
 * Kernel boot UUID from `/proc/sys/kernel/random/boot_id`, or undefined.
 */
export function readKernelBootId(readers?: BootProcReaders): string | undefined {
  const text = (readers?.readBootId ?? defaultReadBootId)();
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  // Refuse delimiters that would break `boot:<bootId>:<pid>@<startTicks>`.
  if (trimmed.length === 0 || trimmed.includes(":") || /\s/.test(trimmed)) return undefined;
  return trimmed;
}

export interface BootAnchor {
  /** Token component: kernel boot_id UUID, or decimal btime when UUID absent. */
  bootId: string;
  /** `/proc/stat` btime seconds (gate that boot-anchored tokens are allowed). */
  btime: number;
}

/**
 * Resolve a boot anchor only when `/proc/stat` `btime` is available.
 * Prefers the kernel boot_id UUID; falls back to decimal btime as the id.
 */
export function resolveBootAnchor(readers?: BootProcReaders): BootAnchor | undefined {
  const btime = readBootBtime(readers);
  if (btime === undefined) return undefined;
  const uuid = readKernelBootId(readers);
  return { bootId: uuid ?? String(btime), btime };
}

/**
 * The identity to record for `pid`, or undefined when it cannot be read.
 *
 * Callers MUST treat undefined as a refusal state — "identity unavailable",
 * not "no identity needed" — and must not reserve work for the process.
 * When `btime` is readable, attaches `bootId` (ruling 473).
 */
export function recordIdentity(pid: number, readers?: BootProcReaders): ProcessIdentity | undefined {
  const facts = readProcessFacts(pid);
  if (facts === undefined) return undefined;
  const identity: ProcessIdentity = { pid, startTicks: facts.startTicks };
  const anchor = resolveBootAnchor(readers);
  if (anchor !== undefined) identity.bootId = anchor.bootId;
  return identity;
}

export interface IdentityVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Re-read /proc and decide whether `identity` is still the recorded process.
 * Refusals carry a machine-readable reason (never prose the caller must parse
 * for meaning): the pid is gone, the pid was reused, the boot changed, or the
 * identity given was absent/malformed.
 */
export function verifyIdentity(
  identity: ProcessIdentity | null | undefined,
  readers?: BootProcReaders,
): IdentityVerdict {
  if (identity === null || identity === undefined) return { ok: false, reason: "no identity recorded" };
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !Number.isInteger(identity.startTicks) || identity.startTicks <= 0) {
    return { ok: false, reason: "malformed identity" };
  }
  if (identity.bootId !== undefined) {
    if (typeof identity.bootId !== "string" || identity.bootId.length === 0 || identity.bootId.includes(":")) {
      return { ok: false, reason: "malformed identity" };
    }
    const anchor = resolveBootAnchor(readers);
    if (anchor === undefined) {
      return { ok: false, reason: "boot anchor unavailable (cannot verify boot-id birth token)" };
    }
    if (anchor.bootId !== identity.bootId) {
      return {
        ok: false,
        reason: `boot changed (recorded bootId ${identity.bootId} does not match current ${anchor.bootId})`,
      };
    }
  }
  const facts = readProcessFacts(identity.pid);
  if (facts === undefined) {
    return { ok: false, reason: `pid ${identity.pid} has no live /proc entry (process gone, or /proc unavailable)` };
  }
  if (facts.startTicks !== identity.startTicks) {
    return {
      ok: false,
      reason: `pid ${identity.pid} was reused (startTicks ${facts.startTicks} does not match the recorded ${identity.startTicks})`,
    };
  }
  return { ok: true };
}

/**
 * The ledger's birthIdentity string for an identity.
 * Boot-anchored (ruling 473): `boot:<bootId>:<pid>@<startTicks>`.
 * Legacy (ruling 22): `<pid>@<startTicks>`.
 */
export function birthIdentityOf(identity: ProcessIdentity | null | undefined): string | null {
  if (identity === null || identity === undefined) return null;
  if (!Number.isInteger(identity.pid) || !Number.isInteger(identity.startTicks)) return null;
  if (identity.bootId !== undefined) {
    if (typeof identity.bootId !== "string" || identity.bootId.length === 0 || identity.bootId.includes(":")) {
      return null;
    }
    return `boot:${identity.bootId}:${identity.pid}@${identity.startTicks}`;
  }
  return `${identity.pid}@${identity.startTicks}`;
}

/** Parse a ledger birthIdentity back to `{pid, startTicks[, bootId]}` (no /proc read). */
export function identityFromBirth(text: unknown): ProcessIdentity | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  const bootMatch = /^boot:([^:]+):(\d+)@(\d+)$/.exec(trimmed);
  if (bootMatch) {
    const bootId = bootMatch[1]!;
    const pid = Number(bootMatch[2]);
    const startTicks = Number(bootMatch[3]);
    if (bootId.length === 0 || bootId.includes(":")) return undefined;
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(startTicks) || startTicks <= 0) return undefined;
    return { pid, startTicks, bootId };
  }
  const match = /^(\d+)@(\d+)$/.exec(trimmed);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const startTicks = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(startTicks) || startTicks <= 0) return undefined;
  return { pid, startTicks };
}

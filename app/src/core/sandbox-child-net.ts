/**
 * Child network lockdown env (docs/33 §5.3; Grok child_net reduced).
 *
 * `HZ_SANDBOX_CHILD_NET=off` tells `hz-sandbox-exec` to apply userns+netns
 * network-off. Config file key `sandboxChildNet: "off"` maps to the same env at
 * startup when the variable is unset (env wins).
 *
 * WSL is a special case with a real host limitation: `unshare(CLONE_NEWNET)`
 * is not permitted there, so a sandboxed child started with child net `off`
 * fails before exec (`hz-sandbox-exec: exec /bin/true: Operation not permitted`).
 * On a WSL host the default is therefore `on` — explicitly, with a notice, and
 * with the network dimension reported unconfined. `on` is never a silent
 * substitution for a requested `off`; an explicit value always wins.
 */

import { readFileSync } from "node:fs";
import type { EnvLike } from "./config";

export type SandboxChildNetMode = "off" | "on";

/** Where a child-net decision came from (for notices and truthful reports). */
export type SandboxChildNetSource = "explicit" | "wsl-default" | "default";

/** Visible once-per-process notice for the WSL child-net default. */
export const WSL_CHILD_NET_NOTICE =
  "[sandbox] WSL detected: sandboxed children default to HZ_SANDBOX_CHILD_NET=on " +
  "because unshare(CLONE_NEWNET) is not permitted on this host; network egress is NOT " +
  "confined by the sandbox. Set HZ_SANDBOX_CHILD_NET=off to require network isolation " +
  "(it will fail closed here).";

export function parseSandboxChildNet(raw: unknown): SandboxChildNetMode | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "off") return "off";
  if (t === "on") return "on";
  return undefined;
}

/** Apply user-config `sandboxChildNet` when `HZ_SANDBOX_CHILD_NET` is unset. */
export function applySandboxChildNetFromConfig(
  configFile: { sandboxChildNet?: unknown },
  env: EnvLike,
): void {
  const existing = env.HZ_SANDBOX_CHILD_NET;
  if (typeof existing === "string" && existing.trim() !== "") return;
  const parsed = parseSandboxChildNet(configFile.sandboxChildNet);
  if (parsed === "off") env.HZ_SANDBOX_CHILD_NET = "off";
}

export function sandboxChildNetOffRequested(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_CHILD_NET;
  return typeof raw === "string" && raw.trim().toLowerCase() === "off";
}

/* --------------------------- WSL host detection --------------------------- */

export interface SandboxHostSignals {
  /** `/proc/sys/kernel/osrelease` */
  osrelease?: string;
  /** `/proc/version` */
  procVersion?: string;
}

/**
 * True when either host signal names Microsoft (the WSL kernel signature).
 * Pure so the WSL decision is unit-testable off-host.
 */
export function signalsIndicateWsl(osrelease: unknown, procVersion: unknown): boolean {
  const namesMicrosoft = (value: unknown): boolean =>
    typeof value === "string" && value.toLowerCase().includes("microsoft");
  return namesMicrosoft(osrelease) || namesMicrosoft(procVersion);
}

/** Read the host signals from /proc (absent entries stay undefined). */
export function readSandboxHostSignals(): SandboxHostSignals {
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    osrelease: read("/proc/sys/kernel/osrelease"),
    procVersion: read("/proc/version"),
  };
}

let cachedWsl: boolean | undefined;

/** True on a WSL host. Cached; `resetSandboxHostProbeCache()` clears for tests. */
export function hostIsWsl(): boolean {
  if (cachedWsl === undefined) {
    const signals = readSandboxHostSignals();
    cachedWsl = signalsIndicateWsl(signals.osrelease, signals.procVersion);
  }
  return cachedWsl;
}

/** Test seam: forget the cached host probe. */
export function resetSandboxHostProbeCache(): void {
  cachedWsl = undefined;
}

export interface SandboxChildNetResolution {
  mode: SandboxChildNetMode;
  source: SandboxChildNetSource;
  wsl: boolean;
  /** True only when WSL supplied `on` because nothing was requested. */
  wslDefaultChildNet: boolean;
  notices: string[];
}

/**
 * Resolve the child-net mode for a sandboxed child.
 *
 * An explicit `off`/`on` (child env, parent env, or user config, which all
 * arrive through `env`) always wins. Only an ABSENT value takes the WSL default,
 * and that default carries a notice so it is visible rather than silent.
 */
export function resolveSandboxChildNet(input: {
  env: Record<string, string | undefined>;
  /** Test seam / explicit host posture; defaults to the cached live probe. */
  wsl?: boolean;
}): SandboxChildNetResolution {
  const raw = input.env.HZ_SANDBOX_CHILD_NET;
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const wsl = input.wsl ?? hostIsWsl();
  if (trimmed !== "") {
    // Mirror hz-sandbox-exec exactly: only the literal value `on` disables
    // isolation; every other explicit value (including a typo) requests
    // isolation. A typo must never silently become the WSL `on` default.
    const mode: SandboxChildNetMode = trimmed === "on" ? "on" : "off";
    return { mode, source: "explicit", wsl, wslDefaultChildNet: false, notices: [] };
  }
  if (wsl) {
    return {
      mode: "on",
      source: "wsl-default",
      wsl: true,
      wslDefaultChildNet: true,
      notices: [WSL_CHILD_NET_NOTICE],
    };
  }
  return { mode: "off", source: "default", wsl, wslDefaultChildNet: false, notices: [] };
}

/**
 * Propagate child network-off to sandbox-wrapped spawns. Does not overwrite an
 * explicit value on the child env.
 *
 * Kept for the legacy env-merge path; `owned-spawn.ts` resolves the full policy
 * with `resolveSandboxChildNet` (which also handles the WSL default).
 */
export function mergeSandboxChildNetSpawnEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (base.HZ_SANDBOX_CHILD_NET !== undefined && base.HZ_SANDBOX_CHILD_NET !== "") return base;
  if (sandboxChildNetOffRequested(process.env)) {
    return { ...base, HZ_SANDBOX_CHILD_NET: "off" };
  }
  return base;
}

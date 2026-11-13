/**
 * Child network lockdown env (docs/33 §5.3; Grok child_net reduced).
 *
 * `HZ_SANDBOX_CHILD_NET=off` tells `hz-sandbox-exec` to apply userns+netns
 * network-off. Config file key `sandboxChildNet: "off"` maps to the same env at
 * startup when the variable is unset (env wins).
 */

import type { EnvLike } from "./config";

export type SandboxChildNetMode = "off" | "on";

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

/**
 * Propagate child network-off to sandbox-wrapped spawns. Does not overwrite an
 * explicit value on the child env.
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

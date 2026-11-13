/**
 * Product-runtime EffectHost kernel posture (ruling **340**).
 *
 * `HZ_EFFECT_HOST_KERNEL` unset still means `off` for `hzcode doctor` and raw
 * env diagnosis. `createRuntime` may apply `=default` on Linux when sandbox
 * wrap is active, or honor user-config `effectHostKernel` when the env is unset —
 * prototype spine only, not full EffectHost.
 */

import type { EnvLike } from "./config";
import { effectHostKernelMode, type EffectHostKernelMode } from "./effect-kernel-mutation-route";

export type EffectHostKernelConfigMode = "default" | "require";

export function parseEffectHostKernelConfig(raw: unknown): EffectHostKernelConfigMode | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "default" || t === "1" || t === "true" || t === "yes" || t === "opt-in") return "default";
  if (t === "require") return "require";
  return undefined;
}

export function effectHostKernelEnvUnset(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_EFFECT_HOST_KERNEL?.trim();
  return raw === undefined || raw === "";
}

/**
 * True when Linux and product sandbox wrap is likely active for shell children.
 * `kernelSandboxEnforced` is from `kernelEnforcesProcessSandbox` after start.
 */
export function sandboxWrapActiveForEffectHost(
  env: Record<string, string | undefined>,
  kernelSandboxEnforced?: boolean,
): boolean {
  if (process.platform !== "linux") return false;
  if (env.HZ_SANDBOX_EXEC === "0") return false;
  if (env.HZ_SANDBOX_REQUIRE === "1") return true;
  if (env.HZ_SANDBOX_EXEC === "1") return true;
  return kernelSandboxEnforced === true;
}

export type ApplyEffectHostKernelResult = {
  applied?: "config" | "sandbox-default";
  mode?: EffectHostKernelMode;
  notice?: string;
};

/** Apply user-config `effectHostKernel` when `HZ_EFFECT_HOST_KERNEL` is unset. */
export function applyEffectHostKernelFromUserConfig(
  configFile: { effectHostKernel?: unknown },
  env: EnvLike,
): ApplyEffectHostKernelResult {
  if (!effectHostKernelEnvUnset(env as Record<string, string | undefined>)) return {};
  const parsed = parseEffectHostKernelConfig(configFile.effectHostKernel);
  if (parsed === undefined) return {};
  env.HZ_EFFECT_HOST_KERNEL = parsed;
  return {
    applied: "config",
    mode: effectHostKernelMode(env as Record<string, string | undefined>),
    notice:
      `[effect-host-kernel] config effectHostKernel=${parsed} → HZ_EFFECT_HOST_KERNEL=${parsed} (env was unset; prototype spine — not full EffectHost)`,
  };
}

/** Apply `=default` on Linux when sandbox wrap is active and env still unset. */
export function applyEffectHostKernelSandboxDefault(
  env: EnvLike,
  kernelSandboxEnforced: boolean,
): ApplyEffectHostKernelResult {
  const rec = env as Record<string, string | undefined>;
  if (!effectHostKernelEnvUnset(rec)) return {};
  if (!sandboxWrapActiveForEffectHost(rec, kernelSandboxEnforced)) return {};
  env.HZ_EFFECT_HOST_KERNEL = "default";
  return {
    applied: "sandbox-default",
    mode: "default",
    notice:
      "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL=default (runtime: Linux + sandbox wrap active; env was unset — prototype spine; `hzcode doctor` still reports off without export)",
  };
}

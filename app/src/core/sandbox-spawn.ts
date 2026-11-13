/**
 * sandbox-spawn.ts — route shell children through hz-sandbox-exec when enforced.
 *
 * Auto wrap is best-effort unless `HZ_SANDBOX_REQUIRE=1` (or `sandboxWrap: true`
 * / `HZ_SANDBOX_EXEC=1`), which fail closed when the helper cannot confine.
 */

import type { EnforcementOutcome, SandboxMode, SandboxSpawnKernel } from "../contracts";
import { resolveSandboxExecBinary } from "./kernel";

export function enforcementHasAppliedDimension(outcome: EnforcementOutcome): boolean {
  if (outcome.status !== "report") return false;
  return outcome.dimensions.some((d) => d.guarantee === "enforced");
}

/**
 * Map a SandboxMode to the Landlock FS mode env for hz-sandbox-exec.
 * `danger-full-access` returns undefined (no FS fence).
 */
export function sandboxFsModeFor(mode: SandboxMode): "read-only" | "workspace-write" | undefined {
  if (mode === "read-only") return "read-only";
  if (mode === "workspace-write") return "workspace-write";
  return undefined;
}

/** True when the kernel reports at least one enforced sandbox dimension. */
export async function kernelEnforcesProcessSandbox(kernel: SandboxSpawnKernel): Promise<boolean> {
  if (process.env.HZ_SANDBOX_EXEC === "0") return false;
  if (process.env.HZ_SANDBOX_EXEC === "1") return resolveSandboxExecBinary() !== undefined;
  if (kernel.mode !== "trusted") return false;
  try {
    const outcome = await kernel.sandboxReport("workspace-write", { allowPartial: true });
    if (outcome.status !== "report") return false;
    const processEnforced = outcome.dimensions.some(
      (d) => d.dimension === "process" && d.guarantee === "enforced",
    );
    return processEnforced && resolveSandboxExecBinary() !== undefined;
  } catch {
    return false;
  }
}

export const SANDBOX_AUTO_LABELS = new Set(["shell", "shell_session", "code_mode"]);

/** True when callers asked for fail-closed confinement (`HZ_SANDBOX_REQUIRE=1`). */
export function sandboxWrapRequired(): boolean {
  return process.env.HZ_SANDBOX_REQUIRE === "1";
}

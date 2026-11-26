/**
 * P0-1 / ruling **721** — mutating `mcp.invoke` honesty under EffectHost-on.
 */

import { effectHostKernelMode } from "./effect-kernel-mutation-route";
import { isMcpToolName, mcpToolClaimsReadOnly } from "./mcp/registry";

export const EFFECT_HOST_KERNEL_MCP_READONLY_AMBIENT_REFUSED_NOTICE =
  "[effect-host-kernel] refused — read-only mcp.invoke is still ambient (not kernel OwnerLog-admitted)";

const EFFECT_HOST_KERNEL_REQUIRE_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL=require: refused — mutation not routed through kernel";

/** Notice when a mutating MCP tool call is blocked under EffectHost-on (ruling **721**). */
export const EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: refused — mutating mcp.invoke is not kernel OwnerLog-admitted";

/**
 * Refuse mutating `mcp.invoke` when EffectHost is on — no kernel OwnerLog prepare/execute
 * route yet. Read-only MCP (`readOnlyHint === true`) is not refused here (under `=require`
 * read-only MCP is still refused as an ambient never-routable tool via **649**).
 */
export function effectHostMcpInvokeMutatingRefusal(
  toolName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mode = effectHostKernelMode(env);
  if (mode === "off") return undefined;
  if (!isMcpToolName(toolName)) return undefined;
  if (mcpToolClaimsReadOnly(toolName)) return undefined;
  if (mode === "require") {
    return (
      `${EFFECT_HOST_KERNEL_REQUIRE_NOTICE} ` +
      `(mutating mcp.invoke is not kernel OwnerLog-admitted — ruling **721**; ${toolName})`
    );
  }
  return `${EFFECT_HOST_KERNEL_MCP_INVOKE_MUTATING_REFUSED_NOTICE} (${toolName})`;
}

/**
 * P0-1 (ruling 919): refusing an ambient read-only MCP call under `=default`/
 * `=1` is the DEFAULT posture now, because such a call still runs in ambient Bun
 * with no kernel OwnerLog admission — "the kernel owns it or the call is
 * refused". `HZ_EFFECT_HOST_MCP_READONLY_STRICT=0` and `HZ_EFFECT_HOST_STRICT=0`
 * do not restore the ambient call (**956**). `=require` already refuses every
 * ambient MCP tool, so this gate stays inert there.
 */
export function effectHostMcpReadOnlyStrictEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.HZ_EFFECT_HOST_MCP_READONLY_STRICT ?? env.HZ_EFFECT_HOST_STRICT ?? "")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return true;
}

export function effectHostMcpInvokeAmbientRefusal(
  toolName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mode = effectHostKernelMode(env);
  if (mode !== "default" && mode !== "opt-in") return undefined;
  if (!isMcpToolName(toolName) || !mcpToolClaimsReadOnly(toolName)) return undefined;
  return `${EFFECT_HOST_KERNEL_MCP_READONLY_AMBIENT_REFUSED_NOTICE} (${toolName})`;
}
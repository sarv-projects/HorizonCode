/**
 * P0-1 / ruling **721** — mutating `mcp.invoke` honesty under EffectHost-on.
 */

import { effectHostKernelMode } from "./effect-kernel-mutation-route";
import { isMcpToolName, mcpToolClaimsReadOnly } from "./mcp/registry";

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
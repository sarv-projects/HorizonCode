/**
 * OpenCode-style permission vocabulary (`{ action, resource }` rows; docs/30 §8 #6).
 */

import type { GuardKind } from "../contracts";

/** Presentation / saved-row action name (OpenCode built-ins). */
export function openCodeActionForGuardKind(kind: GuardKind | string): string {
  if (kind === "fs.read") return "read";
  if (kind === "fs.write") return "edit";
  if (kind === "shell.exec") return "shell";
  if (kind === "net.fetch") return "webfetch";
  if (kind === "mcp.invoke") return "mcp";
  if (kind === "spawn") return "shell";
  return kind.trim() || "other";
}

/** Approval card lines naming the grant tuple checked by the guard. */
export function permissionActionResourceLines(kind: GuardKind | string, target: string): string[] {
  const resource = target.trim();
  if (resource === "") return [];
  const action = openCodeActionForGuardKind(kind);
  return [`action: ${action}`, `resource: ${resource}`];
}
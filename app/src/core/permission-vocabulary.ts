/**
 * OpenCode-style permission vocabulary (`{ action, resource }` rows; docs/30 §8 #6).
 */

import type { GuardKind } from "../contracts";

/** Closed permission effect tokens used by the multi-resource projector. */
export type PermissionEffect = "allow" | "ask" | "deny";

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

/**
 * OpenCode multi-resource fold: deny > ask > allow (docs/30 §8 #6 residual).
 * An empty list is allow (nothing tightened the batch).
 */
export function foldPermissionEffects(effects: readonly PermissionEffect[]): PermissionEffect {
  let folded: PermissionEffect = "allow";
  for (const effect of effects) {
    if (effect === "deny") return "deny";
    if (effect === "ask") folded = "ask";
  }
  return folded;
}

/**
 * Project one action + N resources onto approval card lines. A single resource
 * keeps the legacy two-line shape; multiple resources share one `action:` line.
 */
export function permissionMultiResourceLines(
  kind: GuardKind | string,
  resources: readonly string[],
): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of resources) {
    const resource = raw.trim();
    if (resource === "" || seen.has(resource)) continue;
    seen.add(resource);
    cleaned.push(resource);
  }
  if (cleaned.length === 0) return [];
  if (cleaned.length === 1) return permissionActionResourceLines(kind, cleaned[0]!);
  const action = openCodeActionForGuardKind(kind);
  return [`action: ${action}`, ...cleaned.map((resource) => `resource: ${resource}`)];
}
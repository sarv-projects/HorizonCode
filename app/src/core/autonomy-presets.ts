/**
 * autonomy-presets.ts — Plandex-style autonomy ladder (docs/30 §8 #14 reduced).
 *
 * Data-driven presets beside permission modes: a config `autonomy` name selects
 * a starting `permissionMode` when `permissionMode` is absent.
 */

import type { PermissionMode } from "./permission-mode";

export type AutonomyPresetId = "manual" | "assisted" | "auto-edits" | "plan-only";

export interface AutonomyPreset {
  id: AutonomyPresetId;
  description: string;
  permissionMode: PermissionMode;
}

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = [
  {
    id: "manual",
    description: "kernel guard with human approval for asks (default permission mode)",
    permissionMode: "default",
  },
  {
    id: "assisted",
    description: "read-only: no writes, shell or MCP invoke",
    permissionMode: "read-only",
  },
  {
    id: "auto-edits",
    description: "auto-approve in-workspace file writes; shell and network stay guarded",
    permissionMode: "accept-edits",
  },
  {
    id: "plan-only",
    description: "plan mode: writes stage as proposals only",
    permissionMode: "plan",
  },
];

const BY_ID = new Map(AUTONOMY_PRESETS.map((p) => [p.id, p]));

export function parseAutonomyPreset(value: unknown): AutonomyPreset | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase().replace(/_/g, "-") as AutonomyPresetId;
  return BY_ID.get(id);
}

export function autonomyPresetError(value: unknown): string {
  const ids = AUTONOMY_PRESETS.map((p) => p.id).join(", ");
  return `unknown autonomy preset ${JSON.stringify(String(value ?? ""))}; use one of ${ids}`;
}

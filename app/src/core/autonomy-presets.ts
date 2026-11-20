/**
 * autonomy-presets.ts — product autonomy ladder (docs/30 §8 #14 reduced) plus
 * envelope-profile aliases (audit/architecture-critique-verification-2026-11-19).
 *
 * Data-driven presets beside permission modes: a config `autonomy` name selects
 * a starting `permissionMode` when `permissionMode` is absent.
 *
 * Envelope presets (`pilot` / `autonomous` / `unattended` / `regulated`) select
 * starting permission mode AND an envelope tier (`autonomy-envelope.ts`) that
 * auto-answers bounded asks. OS blast-radius confinement and lease-on-allow
 * remain P0 OPEN. Granular `HZ_*` escape hatches stay available.
 */

import type { PermissionMode } from "./permission-mode";
import type { AutonomyEnvelopeTier } from "./autonomy-envelope";

export type AutonomyPresetId =
  | "manual"
  | "assisted"
  | "auto-edits"
  | "plan-only"
  | "pilot"
  | "autonomous"
  | "unattended"
  | "regulated";

export interface AutonomyPreset {
  id: AutonomyPresetId;
  description: string;
  permissionMode: PermissionMode;
  /** Intended envelope posture (honest target; not OS-enforced yet). */
  envelopeTarget:
    | "interactive-ask"
    | "worktree-autonomy"
    | "unattended-stage-boundaries"
    | "regulated-kernel-require";
  envelopeTier: AutonomyEnvelopeTier;
}

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = [
  {
    id: "manual",
    description: "kernel guard with human approval for asks (default permission mode)",
    permissionMode: "default",
    envelopeTarget: "interactive-ask",
    envelopeTier: "interactive",
  },
  {
    id: "assisted",
    description: "read-only: no writes, shell or MCP invoke",
    permissionMode: "read-only",
    envelopeTarget: "interactive-ask",
    envelopeTier: "interactive",
  },
  {
    id: "auto-edits",
    description: "auto-approve in-workspace file writes; shell and network stay guarded",
    permissionMode: "accept-edits",
    envelopeTarget: "worktree-autonomy",
    envelopeTier: "interactive",
  },
  {
    id: "plan-only",
    description: "plan mode: writes stage as proposals only",
    permissionMode: "plan",
    envelopeTarget: "interactive-ask",
    envelopeTier: "interactive",
  },
  {
    id: "pilot",
    description:
      "pilot envelope: auto-approve in-workspace reads and verification-shaped shell; edits, push, egress and sensitive paths still ask",
    permissionMode: "default",
    envelopeTarget: "worktree-autonomy",
    envelopeTier: "pilot-autonomous",
  },
  {
    id: "autonomous",
    description:
      "autonomous envelope: same auto-approve band as pilot; in-workspace writes still ask; OS confinement OPEN",
    permissionMode: "default",
    envelopeTarget: "worktree-autonomy",
    envelopeTier: "pilot-autonomous",
  },
  {
    id: "unattended",
    description:
      "unattended envelope: pilot band plus non-sensitive in-workspace writes; push, outside workspace, net and sensitive paths still ask",
    permissionMode: "default",
    envelopeTarget: "unattended-stage-boundaries",
    envelopeTier: "unattended",
  },
  {
    id: "regulated",
    description:
      "regulated envelope: accept-edits in-workspace writes only (no verification-shell auto); HZ_EFFECT_HOST_KERNEL=require when env unset (ruling 630)",
    permissionMode: "accept-edits",
    envelopeTarget: "regulated-kernel-require",
    envelopeTier: "regulated",
  },
];

const BY_ID = new Map(AUTONOMY_PRESETS.map((p) => [p.id, p]));

/** Legacy ids remain valid; envelope aliases resolve to the same preset objects. */
export function parseAutonomyPreset(value: unknown): AutonomyPreset | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase().replace(/_/g, "-") as AutonomyPresetId;
  return BY_ID.get(id);
}

export function autonomyPresetError(value: unknown): string {
  const ids = AUTONOMY_PRESETS.map((p) => p.id).join(", ");
  return `unknown autonomy preset ${JSON.stringify(String(value ?? ""))}; use one of ${ids}`;
}

/**
 * autonomy-envelope.ts — real autonomy posture beside permission modes (ruling
 * slice 2026-11-19). Preset ids select an envelope tier that can auto-answer
 * kernel ASKs the bare permission mode would leave to a human.
 */

import * as path from "node:path";
import type { GuardAction } from "../contracts";
import type { AutonomyPresetId } from "./autonomy-presets";
import { acceptEditsWriteAutoApproves, type PermissionMode } from "./permission-mode";
import { isGitPushCommand, isVerificationShellCommand } from "./verification-shell";

/** Envelope tiers with distinct auto-approve rules (not permission-mode aliases). */
export type AutonomyEnvelopeTier = "interactive" | "pilot-autonomous" | "unattended" | "regulated";

export function envelopeTierForPreset(id: AutonomyPresetId | undefined): AutonomyEnvelopeTier {
  switch (id) {
    case "pilot":
    case "autonomous":
      return "pilot-autonomous";
    case "unattended":
      return "unattended";
    case "regulated":
      return "regulated";
    default:
      return "interactive";
  }
}

export function envelopeTierForAutonomyName(name: string | undefined): AutonomyEnvelopeTier {
  if (name === undefined || name.trim() === "") return "interactive";
  const id = name.trim().toLowerCase().replace(/_/g, "-") as AutonomyPresetId;
  return envelopeTierForPreset(id);
}

function shellCwdInsideWorkspace(action: GuardAction, workspace: string, inside: (target: string, workspace: string) => boolean): boolean {
  const cwd = action.detail?.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "") return inside(cwd, workspace);
  return inside(workspace, workspace);
}

function pilotAutonomousApproves(
  action: GuardAction,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): boolean {
  if (action.kind === "fs.read") {
    return inside(action.target, workspace);
  }
  if (action.kind === "shell.exec") {
    const command = action.target;
    if (isGitPushCommand(command)) return false;
    if (!isVerificationShellCommand(command)) return false;
    return shellCwdInsideWorkspace(action, workspace, inside);
  }
  return false;
}

function unattendedApproves(
  action: GuardAction,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): boolean {
  if (action.kind === "fs.write") {
    return acceptEditsWriteAutoApproves(action, workspace, inside);
  }
  return pilotAutonomousApproves(action, workspace, inside);
}

/**
 * Whether the autonomy envelope answers an ASK with yes. Called from GuardGate
 * after the kernel said ask and before the human handler. Never widens a deny.
 */
export function envelopeAutoApproves(
  tier: AutonomyEnvelopeTier,
  mode: PermissionMode | undefined,
  action: GuardAction | undefined,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): boolean {
  if (action === undefined) return false;
  switch (tier) {
    case "pilot-autonomous":
      return pilotAutonomousApproves(action, workspace, inside);
    case "unattended":
      return unattendedApproves(action, workspace, inside);
    case "regulated":
      return action.kind === "fs.write" && acceptEditsWriteAutoApproves(action, workspace, inside);
    case "interactive":
    default:
      return false;
  }
}

/**
 * Legacy accept-edits write auto-approve: used for auto-edits preset and default
 * modes, but NOT for pilot/autonomous envelopes (writes still ask there).
 */
export function permissionModeAutoApproves(
  tier: AutonomyEnvelopeTier,
  mode: PermissionMode | undefined,
  action: GuardAction | undefined,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): boolean {
  if (tier === "pilot-autonomous" || tier === "unattended") return false;
  if (mode !== "accept-edits" || action === undefined) return false;
  if (action.kind !== "fs.write") return false;
  return acceptEditsWriteAutoApproves(action, workspace, inside);
}

/** Classify a guard action for tests and scrollback copy. */
export function classifyEnvelopeAction(
  tier: AutonomyEnvelopeTier,
  action: GuardAction,
): "auto-read" | "auto-verification-shell" | "auto-write" | "boundary" | "passthrough" {
  if (action.kind === "net.fetch" || action.kind === "mcp.invoke" || action.kind === "spawn") return "boundary";
  if (action.kind === "shell.exec" && isGitPushCommand(action.target)) return "boundary";
  if (tier === "pilot-autonomous" || tier === "unattended") {
    if (action.kind === "fs.read") return "auto-read";
    if (action.kind === "shell.exec" && isVerificationShellCommand(action.target)) return "auto-verification-shell";
    if (tier === "unattended" && action.kind === "fs.write") return "auto-write";
    if (action.kind === "fs.write" || action.kind === "shell.exec") return "boundary";
  }
  if (tier === "regulated" && action.kind === "fs.write") return "passthrough";
  return "passthrough";
}
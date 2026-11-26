/**
 * autonomy-envelope.ts — real autonomy posture beside permission modes (ruling
 * slice 2026-11-19, ruling 871 blast-radius confinement). Preset ids select an
 * envelope tier that can auto-answer kernel ASKs the bare permission mode would
 * leave to a human, bounded by strict blast-radius confinement policies.
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

/* ----------------------- blast-radius patterns & guards ---------------------- */

export const DESTRUCTIVE_SHELL_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+([/~]|(\.\.[/\\])|([a-z]:[/\\])|(\*))/i,
  /\brmdir\s+.*\/s/i,
  /\bdel\s+.*(\/s|\/f|\*)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*\bof=\/dev\//i,
  /:(\(\)\s*\{|;)/,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\brunas\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i,
  /\bwget\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i,
];

export function isDestructiveShellCommand(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  return DESTRUCTIVE_SHELL_PATTERNS.some((pattern) => pattern.test(command));
}

export const SYSTEM_BOUNDARY_PATH_PATTERNS: readonly RegExp[] = [
  /^(?:\/|[a-z]:[/\\])(?:etc|usr|bin|sbin|var|boot|root|sys|proc|dev)(?:[/\\]|$)/i,
  /^[a-z]:[/\\](?:windows|winnt|program files|program files \(x86\)|programdata)(?:[/\\]|$)/i,
  /(?:^|[/\\])\.(?:ssh|aws|gnupg|kube|azure|gcloud)(?:[/\\]|$)/i,
  /(?:^|[/\\])(?:id_rsa|id_ed25519|\.npmrc|\.netrc|credentials\.db)(?:[/\\]|$)/i,
  /^[a-z]:[/\\]?$/i,
];

export function isSystemBoundaryPath(targetPath: string): boolean {
  if (typeof targetPath !== "string" || targetPath.trim() === "") return false;
  const trimmed = targetPath.trim();
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized === "/" || normalized === "~") return true;
  const resolvedNorm = path.resolve(trimmed).replace(/\\/g, "/");
  return SYSTEM_BOUNDARY_PATH_PATTERNS.some(
    (pattern) => pattern.test(trimmed) || pattern.test(normalized) || pattern.test(resolvedNorm),
  );
}

export interface BlastRadiusAssessment {
  withinBlastRadius: boolean;
  tier: AutonomyEnvelopeTier;
  actionKind: string;
  target: string;
  violation?: string;
}

/**
 * Assesses whether an action remains strictly confined within the blast radius
 * of the designated autonomy envelope tier.
 */
export function assessBlastRadius(
  tier: AutonomyEnvelopeTier,
  action: GuardAction,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): BlastRadiusAssessment {
  const target = action.target ?? "";

  if (action.kind === "fs.read" || action.kind === "fs.write") {
    if (isSystemBoundaryPath(target)) {
      return {
        withinBlastRadius: false,
        tier,
        actionKind: action.kind,
        target,
        violation: "target path is a system boundary path outside safe envelope",
      };
    }
    if (action.kind === "fs.write" && !inside(target, workspace)) {
      return {
        withinBlastRadius: false,
        tier,
        actionKind: action.kind,
        target,
        violation: "write target is outside workspace blast radius",
      };
    }
  }

  if (action.kind === "shell.exec") {
    if (isDestructiveShellCommand(target)) {
      return {
        withinBlastRadius: false,
        tier,
        actionKind: action.kind,
        target,
        violation: "command matches destructive or privilege escalation blast-radius pattern",
      };
    }
    if (isGitPushCommand(target)) {
      return {
        withinBlastRadius: false,
        tier,
        actionKind: action.kind,
        target,
        violation:
          tier === "unattended"
            ? "unattended stage-and-exit: remote push held at autonomy envelope boundary for human review"
            : "remote push exceeds local autonomy envelope boundary",
      };
    }
    if (!shellCwdInsideWorkspace(action, workspace, inside)) {
      return {
        withinBlastRadius: false,
        tier,
        actionKind: action.kind,
        target,
        violation: "shell execution cwd is outside workspace blast radius",
      };
    }
  }

  if (action.kind === "net.fetch" || action.kind === "mcp.invoke" || action.kind === "spawn") {
    return {
      withinBlastRadius: false,
      tier,
      actionKind: action.kind,
      target,
      violation: "external network/mcp/spawn action is outside local envelope boundary",
    };
  }

  return { withinBlastRadius: true, tier, actionKind: action.kind, target };
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
    if (isSystemBoundaryPath(action.target)) return false;
    return inside(action.target, workspace);
  }
  if (action.kind === "shell.exec") {
    const command = action.target;
    if (isGitPushCommand(command)) return false;
    if (isDestructiveShellCommand(command)) return false;
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
    if (isSystemBoundaryPath(action.target)) return false;
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

  const assessment = assessBlastRadius(tier, action, workspace, inside);
  if (!assessment.withinBlastRadius) return false;

  switch (tier) {
    case "pilot-autonomous":
      return pilotAutonomousApproves(action, workspace, inside);
    case "unattended":
      return unattendedApproves(action, workspace, inside);
    case "regulated":
      return action.kind === "fs.write" && !isSystemBoundaryPath(action.target) && acceptEditsWriteAutoApproves(action, workspace, inside);
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
  if (isSystemBoundaryPath(action.target)) return false;
  return acceptEditsWriteAutoApproves(action, workspace, inside);
}

/** Classify a guard action for tests and scrollback copy. */
export function classifyEnvelopeAction(
  tier: AutonomyEnvelopeTier,
  action: GuardAction,
): "auto-read" | "auto-verification-shell" | "auto-write" | "boundary" | "passthrough" {
  if (action.kind === "net.fetch" || action.kind === "mcp.invoke" || action.kind === "spawn") return "boundary";
  if (action.kind === "shell.exec") {
    if (isGitPushCommand(action.target) || isDestructiveShellCommand(action.target)) return "boundary";
  }
  if ((action.kind === "fs.read" || action.kind === "fs.write") && isSystemBoundaryPath(action.target)) {
    return "boundary";
  }
  if (tier === "pilot-autonomous" || tier === "unattended") {
    if (action.kind === "fs.read") return "auto-read";
    if (action.kind === "shell.exec" && isVerificationShellCommand(action.target)) return "auto-verification-shell";
    if (tier === "unattended" && action.kind === "fs.write") return "auto-write";
    if (action.kind === "fs.write" || action.kind === "shell.exec") return "boundary";
  }
  if (tier === "regulated" && action.kind === "fs.write") return "passthrough";
  return "passthrough";
}
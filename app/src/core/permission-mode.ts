/**
 * permission-mode.ts — the named permission postures (docs/28 ruling on
 * permission modes; reference: Claude Code default/acceptEdits/plan, codex
 * approval modes).
 *
 *   default       today's behaviour: the kernel guard decides, a human answers asks
 *   plan          the existing plan mode (plan.ts): writes are staged, not applied
 *   accept-edits  an fs.write the guard would ASK about, inside the workspace, is
 *                 answered yes; shell, network, spawn, MCP and every write outside
 *                 the workspace stay exactly as default
 *   read-only     every fs.write and shell.exec is refused before it can run
 *
 * The mode is a policy layer ABOVE the kernel guard and can only narrow or
 * auto-answer an ASK: it never produces an allow the guard did not, and a
 * kernel `deny` (including the kernel-state protection) is final and is never
 * even re-asked. The decision functions here are pure; GuardGate (loop.ts)
 * applies them.
 *
 * There is deliberately NO bypass/yolo mode (docs/28): a mode that answers every
 * ask would also answer the asks that guard exfiltration (net.fetch, spawn, MCP)
 * and the shell, and the only thing left standing would be the kernel deny rules,
 * which cover a fixed list, not intent. `--permission-mode yolo` is refused with
 * a message saying so rather than being silently mapped to something weaker.
 *
 * Source of the starting mode: the `--permission-mode` flag, else the USER
 * config file's `permissionMode`, else `default`. A workspace never supplies
 * one (no workspace file is read for it), and nothing here writes a mode to
 * disk: `/mode` is session-only.
 */

import * as path from "node:path";
import type { GuardAction } from "../contracts";

export type PermissionMode = "default" | "plan" | "accept-edits" | "read-only";

export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "plan", "accept-edits", "read-only"];

/** Names that mean "skip the approvals"; refused on purpose (see the header). */
const BYPASS_NAMES: readonly string[] = ["yolo", "bypass", "bypasspermissions", "bypass-permissions", "dangerously-skip-permissions"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Parse a mode name (case-insensitive; `acceptEdits` and `readonly` spellings accepted). */
export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase().replace(/_/g, "-");
  if (name === "acceptedits") return "accept-edits";
  if (name === "readonly") return "read-only";
  return isPermissionMode(name) ? name : undefined;
}

/** True when `value` names a bypass-style mode this build intentionally does not have. */
export function isBypassName(value: unknown): boolean {
  return typeof value === "string" && BYPASS_NAMES.includes(value.trim().toLowerCase());
}

/** The one explanation printed whenever a bypass mode is asked for. */
export const BYPASS_REFUSAL =
  "there is no bypass/yolo permission mode: it would also answer net.fetch, spawn, MCP and shell asks, leaving only the kernel deny list. Use accept-edits for in-workspace edits";

/** The text for an unknown/bypass mode name, naming the valid ones. */
export function permissionModeError(value: unknown): string {
  if (isBypassName(value)) return BYPASS_REFUSAL;
  return `unknown permission mode ${JSON.stringify(String(value ?? ""))}; use one of ${PERMISSION_MODES.join(", ")}`;
}

/**
 * The reason a mode refuses an action outright, or undefined to leave it to
 * the guard. Only read-only refuses; it applies even when the guard would
 * allow (an in-workspace write is "allow" by default policy).
 */
export function modeRefusal(mode: PermissionMode | undefined, action: GuardAction): string | undefined {
  if (mode !== "read-only") return undefined;
  if (action.kind === "fs.write" || action.kind === "shell.exec") {
    return `read-only permission mode refuses ${action.kind}`;
  }
  return undefined;
}

/** Workspace-relative first segments accept-edits never auto-answers. */
const SENSITIVE_ROOTS: readonly string[] = [".git", ".hz"];

/**
 * Whether the mode answers an ASK for `action` with yes. Only accept-edits does,
 * and only for an fs.write whose target `inside` (the caller's symlink-aware
 * workspace test) puts in the workspace and outside repository/harness state.
 * Everything else, shell included, falls through to the human (or a fail-closed
 * deny when there is none).
 */
export function modeAutoApproves(
  mode: PermissionMode | undefined,
  action: GuardAction | undefined,
  workspace: string,
  inside: (target: string, workspace: string) => boolean,
): boolean {
  if (mode !== "accept-edits" || action === undefined) return false;
  if (action.kind !== "fs.write") return false;
  if (!inside(action.target, workspace)) return false;
  const rel = path.relative(path.resolve(workspace), path.resolve(workspace, action.target));
  const first = rel.split(path.sep)[0] ?? "";
  return !SENSITIVE_ROOTS.includes(first);
}

/** The prompt badge text for a mode (empty for default). */
export function modeBadge(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "PLAN";
    case "accept-edits":
      return "ACCEPT-EDITS";
    case "read-only":
      return "READ-ONLY";
    default:
      return "";
  }
}

/** One-line description for /mode and the startup notice. */
export function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "plan: writes and edits are staged for review (/changes, /apply, /discard)";
    case "accept-edits":
      return "accept-edits: in-workspace write/edit asks are answered yes; shell and everything else ask as usual";
    case "read-only":
      return "read-only: every write and shell command is refused";
    default:
      return "default: the guard decides, you answer asks";
  }
}

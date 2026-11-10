/**
 * permission-mode.ts: the named permission postures (docs/28 ruling on
 * permission modes; reference: Claude Code default/acceptEdits/plan, codex
 * approval modes).
 *
 *   default       today's behaviour: the kernel guard decides, a human answers asks
 *   plan          the existing plan mode (plan.ts): writes are staged, not applied
 *   accept-edits  an fs.write the guard would ASK about, inside the workspace, is
 *                 answered yes; shell, network, spawn, MCP and every write outside
 *                 the workspace stay exactly as default
 *   read-only     every fs.write, shell.exec and mcp.invoke is refused before it can
 *                 run (an MCP tool can write, so it is refused with the rest). net.fetch
 *                 (a read), LSP/MCP server start and agent/code_mode spawns are left to
 *                 the guard: a child inherits this mode and a code_mode bridge call is
 *                 decided on its own merits, so neither can write or run a command
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
import { realpathish } from "./paths";

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
  if (action.kind === "fs.write" || action.kind === "shell.exec" || action.kind === "mcp.invoke") {
    return `read-only permission mode refuses ${action.kind}`;
  }
  return undefined;
}

/**
 * Directory names (at ANY depth) accept-edits never auto-answers: repository and
 * harness state, and CI/hook directories whose files run later without a shell ask.
 */
const SENSITIVE_DIRS: readonly string[] = [".git", ".hz", ".github", ".gitlab", ".husky", ".circleci", ".devcontainer", ".vscode"];

/**
 * File names (any depth, case-insensitive) that run or configure code later:
 * manifests with scripts, shell startup files, env loaders, CI/hook configs,
 * build files. Writing one is deferred code execution, so a human answers.
 */
const SENSITIVE_FILES: readonly string[] = [
  "package.json", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
  ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".cshrc", ".kshrc", "config.fish", ".gitlab-ci.yml", ".gitmodules", ".gitattributes",
  "jenkinsfile", "makefile", "gnumakefile", "dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
  "lefthook.yml", ".pre-commit-config.yaml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "setup.py", "conftest.py", "justfile", "taskfile.yml",
  "build.rs", "build.gradle", "pom.xml", ".env",
];

function isSensitiveRel(rel: string): boolean {
  // Lowercased throughout: on a case-insensitive filesystem `.GIT/hooks` IS `.git/hooks`.
  const parts = rel.split(path.sep).filter((s) => s !== "").map((s) => s.toLowerCase());
  const base = parts[parts.length - 1] ?? "";
  if (parts.some((seg) => SENSITIVE_DIRS.includes(seg))) return true;
  return SENSITIVE_FILES.includes(base) || base.startsWith(".env.");
}

/**
 * Whether the mode answers an ASK for `action` with yes. Only accept-edits does,
 * and only for an fs.write whose target `inside` (the caller's symlink-aware
 * workspace test) puts in the workspace and outside repository, harness, CI/hook and manifest files (see SENSITIVE_*).
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
  // Judge BOTH the lexical path and the symlink-resolved one: an in-workspace
  // link (`gitlink -> .git`, `notes.md -> package.json`) must not hide a sensitive target.
  const lexical = path.relative(path.resolve(workspace), path.resolve(workspace, action.target));
  const real = path.relative(realpathish(workspace), realpathish(path.resolve(workspace, action.target)));
  return !isSensitiveRel(lexical) && !isSensitiveRel(real);
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
      return "accept-edits: in-workspace write/edit asks are answered yes (not CI/hook/manifest/shell-rc files); shell and everything else ask as usual";
    case "read-only":
      return "read-only: every write, shell command and MCP tool call is refused";
    default:
      return "default: the guard decides, you answer asks";
  }
}

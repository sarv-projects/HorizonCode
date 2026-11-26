/**
 * permission-presentation.ts — human-facing approval copy (ADAPT OpenCode `permission.ts`).
 *
 * Maps guard kinds and targets into a short title + detail lines for the
 * approval card. Does not change guard decisions.
 */

import * as path from "node:path";
import type { ApprovalRequest } from "../contracts";
import {
  openCodeActionForGuardKind,
  permissionActionResourceLines,
  permissionMultiResourceLines,
} from "../core/permission-vocabulary";
import { analyzeShellCompound, shellCompoundPresentationLines, shellSavedGrantTargets } from "../core/shell-split";
import { isWorkspaceTrustApprovalTitle } from "../core/trust";
import { loadSavedAllows } from "../core/saved-allows";
import { formatSessionGrantExpiry, sessionGrantTtlMinutes } from "./grant-ttl";
import { SESSION_LEASE_TTL_MS } from "../core/loop";
import { sanitizeText } from "./style";

export type PermissionPresentation = {
  icon: string;
  title: string;
  lines: string[];
};

/** Show format/invisible Unicode (bidi, zero-width, U+2028/9, U+061C) as visible <U+XXXX>. */
function escapeInvisible(text: string): string {
  return text.replace(/[\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\u061c\ufeff]/g, (c) => {
    return `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
  });
}

/** Neutralize C0/C1 controls (except tab/newline), DEL, and invisible Unicode visibly. */
function escapeCommandLine(text: string): string {
  return escapeInvisible(
    text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
      return `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
    }),
  )
    .replace(/\r?\n/g, " ")
    .trim();
}

function sanitizePresentation(
  presentation: PermissionPresentation,
  isShell: boolean,
): PermissionPresentation {
  const safeTitle = escapeInvisible(sanitizeText(presentation.title)).replace(/\s+/g, " ").trim();
  const safeLines = presentation.lines
    .map((line) =>
      isShell
        ? escapeCommandLine(line)
        : escapeInvisible(sanitizeText(line)).replace(/\s+/g, " ").trim(),
    )
    .filter((line) => line !== "");
  return {
    icon: sanitizeText(presentation.icon).replace(/\s+/g, " ").trim(),
    title: safeTitle,
    lines: safeLines,
  };
}

function relPath(target: string, workspace?: string): string {
  if (workspace === undefined || workspace === "") return target;
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);
  if (resolved === root) return target;
  try {
    const rel = path.relative(root, resolved);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  } catch {
    /* */
  }
  return target;
}

function canonicalKind(kind: string): string {
  return openCodeActionForGuardKind(kind);
}

function withActionResource(
  presentation: PermissionPresentation,
  kind: string,
  target: string,
  resources?: readonly string[],
): PermissionPresentation {
  const head =
    resources !== undefined && resources.length > 0
      ? permissionMultiResourceLines(kind, resources)
      : permissionActionResourceLines(kind, target);
  if (head.length === 0) return presentation;
  return { ...presentation, lines: [...head, ...presentation.lines] };
}

export function permissionPresentationForRequest(
  req: ApprovalRequest,
  workspace?: string,
): PermissionPresentation {
  const kind = canonicalKind(req.kind ?? "other");
  const isShell = kind === "shell";
  const target = (req.detail ?? "").trim();
  const shown = relPath(target, workspace);

  const multi = req.resources;
  if (isShell) {
    const command = target;
    const analysis = command ? analyzeShellCompound(command) : { ok: false as const, reason: "empty" };
    const savedShell =
      workspace !== undefined && workspace !== ""
        ? new Set(
            loadSavedAllows(workspace).flatMap((row) =>
              row.kind === "shell.exec" ? shellSavedGrantTargets(row.kind, row.target) : [],
            ),
          )
        : undefined;
    const compoundLines = command
      ? shellCompoundPresentationLines(analysis, { savedShellTargets: savedShell })
      : [];
    const lines = command ? [`$ ${command}`, ...compoundLines] : [req.title || "run command"];
    return sanitizePresentation(
      withActionResource(
        {
          icon: "#",
          title: analysis.ok && analysis.compound ? "Shell command (compound)" : "Shell command",
          lines,
        },
        req.kind ?? "shell.exec",
        target,
        multi,
      ),
      true,
    );
  }
  if (kind === "read") {
    return sanitizePresentation(
      withActionResource(
        {
          icon: "\u2192",
          title: shown ? `Read ${shown}` : req.title?.trim() || "Read file",
          lines: shown ? [`Path: ${shown}`] : [],
        },
        req.kind ?? "fs.read",
        target,
        multi,
      ),
      false,
    );
  }
  if (kind === "edit") {
    return sanitizePresentation(
      withActionResource(
        {
          icon: "\u2192",
          title: shown ? `Write ${shown}` : req.title?.trim() || "Write file",
          lines: shown ? [`Path: ${shown}`] : [],
        },
        req.kind ?? "fs.write",
        target,
        multi,
      ),
      false,
    );
  }
  if (kind === "webfetch") {
    return sanitizePresentation(
      withActionResource(
        {
          icon: "%",
          title: shown ? `Web fetch ${shown}` : req.title?.trim() || "Network fetch",
          lines: shown ? [`URL: ${shown}`] : [],
        },
        req.kind ?? "net.fetch",
        target,
        multi,
      ),
      false,
    );
  }
  if (kind === "mcp") {
    return sanitizePresentation(
      withActionResource(
        {
          icon: "\u2699",
          title: shown ? `MCP ${shown}` : "MCP tool",
          lines: [req.title || "invoke external MCP tool"],
        },
        req.kind ?? "mcp.invoke",
        target,
        multi,
      ),
      false,
    );
  }
  if (req.kind === "other" && isWorkspaceTrustApprovalTitle(req.title)) {
    return sanitizePresentation(
      {
        icon: "\u26a0",
        title: req.title || "Trust decision",
        lines: target.split("\n").filter((l) => l.trim() !== ""),
      },
      false,
    );
  }
  return sanitizePresentation(
    withActionResource(
      {
        icon: "\u2699",
        title: req.title || `Allow ${kind}`,
        lines: target ? [target] : [],
      },
      req.kind ?? "other",
      target,
    ),
    false,
  );
}

/** Lines shown after the user picks "always" (OpenCode `permissionAlwaysLines`). */
export function permissionAlwaysLines(
  kind: string,
  target: string,
  ttlMs: number = SESSION_LEASE_TTL_MS,
): string[] {
  const expiry = formatSessionGrantExpiry(ttlMs);
  if (target === "" || target === "*") {
    return [`This session will remember yes for ${kind} for ${expiry} (then the grant expires).`];
  }
  return [
    `This session will remember yes for the exact target below for ${expiry} (then the grant expires).`,
    "The choice is also saved under .hz/state/saved-allows.json and rehydrates on the next session start (same TTL).",
    `- ${target}`,
  ];
}

/**
 * Stage 2 (`always_confirm`) lines shown BEFORE saving an "always" grant so
 * the user can inspect the exact permission pattern/scope first.
 */
export function permissionAlwaysConfirmLines(
  kind: string,
  target: string,
  ttlMs: number = SESSION_LEASE_TTL_MS,
): string[] {
  const expiry = formatSessionGrantExpiry(ttlMs);
  const safeKind = sanitizeText(kind).replace(/\s+/g, " ").trim() || "other";
  const safeTarget =
    safeKind === "shell.exec"
      ? escapeCommandLine(target)
      : escapeInvisible(sanitizeText(target)).replace(/\s+/g, " ").trim();
  if (safeTarget === "" || safeTarget === "*") {
    return [
      `Confirm always allow for ${safeKind}`,
      `Scope: session-only (${expiry})`,
    ];
  }
  return [
    `Confirm always allow for ${safeKind}`,
    `Pattern: ${safeTarget}`,
    `Scope: exact target only · expires after ${expiry} (saved in .hz/state/saved-allows.json)`,
  ];
}

/** Stage 3 (`reject_steer`) prompt lines for optional steering instructions. */
export function permissionRejectSteeringLines(actionTitle?: string): string[] {
  const cleanTitle = actionTitle
    ? escapeInvisible(sanitizeText(actionTitle)).replace(/\s+/g, " ").trim()
    : "";
  return [
    cleanTitle !== "" ? `Reject permission: ${cleanTitle}` : "Reject permission",
    "Tell HorizonCode what to do differently (leave blank and press Enter to deny without steering).",
  ];
}

/** Footnote on the approval card when [a]lways is offered. */
export function approvalAlwaysGrantFootnote(ttlMs: number = SESSION_LEASE_TTL_MS): string {
  return `Always = session grant for ${formatSessionGrantExpiry(ttlMs)} (exact target; not a wildcard).`;
}

/**
 * When saved-allows.json lists this target but the guard still asked, the
 * session grant is missing (expired or not rehydrated).
 */
export function savedAllowStaleFootnote(
  workspace: string | undefined,
  kind: string,
  target: string,
  ttlMs: number = SESSION_LEASE_TTL_MS,
): string | undefined {
  const t = target.trim();
  if (workspace === undefined || workspace === "" || t === "") return undefined;
  const remembered = loadSavedAllows(workspace).some((row) => row.kind === kind && row.target === t);
  if (!remembered) return undefined;
  return (
    `saved-allows.json remembers this target, but no active session grant covers it (grants last ${formatSessionGrantExpiry(ttlMs)}). ` +
    "Press [a]lways to renew."
  );
}

export { sessionGrantTtlMinutes };

/** Copy when headless / unattended cannot prompt (OpenCode unattended deny). */
export function formatUnattendedApprovalDenial(
  presentation: PermissionPresentation,
  kind: string,
  detail?: string,
): string {
  const bits = presentation.lines.slice(0, 2).join(" | ");
  const extra = detail && detail !== "" ? ` (${detail})` : bits !== "" ? ` (${bits})` : "";
  return (
    `approval required [${kind}] ${presentation.title}${extra} — denied: no interactive TTY to approve. ` +
    `Attach a terminal, use an interactive session, or pre-approve via an earlier 'always' (saved in saved-allows.json; grants last ${formatSessionGrantExpiry()}).`
  );
}

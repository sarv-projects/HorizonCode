/**
 * permission-presentation.ts — human-facing approval copy (ADAPT OpenCode `permission.ts`).
 *
 * Maps guard kinds and targets into a short title + detail lines for the
 * approval card. Does not change guard decisions.
 */

import * as path from "node:path";
import type { ApprovalRequest } from "../contracts";
import { analyzeShellCompound, shellCompoundPresentationLines } from "../core/shell-split";

export type PermissionPresentation = {
  icon: string;
  title: string;
  lines: string[];
};

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
  if (kind === "fs.read") return "read";
  if (kind === "fs.write") return "edit";
  if (kind === "shell.exec") return "shell";
  if (kind === "net.fetch") return "webfetch";
  if (kind === "mcp.invoke") return "mcp";
  if (kind === "spawn") return "shell";
  return kind;
}

export function permissionPresentationForRequest(
  req: ApprovalRequest,
  workspace?: string,
): PermissionPresentation {
  const kind = canonicalKind(req.kind ?? "other");
  const target = (req.detail ?? "").trim();
  const shown = relPath(target, workspace);

  if (kind === "shell") {
    const command = target;
    const analysis = command ? analyzeShellCompound(command) : { ok: false as const, reason: "empty" };
    const compoundLines = command ? shellCompoundPresentationLines(analysis) : [];
    const lines = command ? [`$ ${command}`, ...compoundLines] : [req.title || "run command"];
    return {
      icon: "#",
      title: analysis.ok && analysis.compound ? "Shell command (compound)" : "Shell command",
      lines,
    };
  }
  if (kind === "read") {
    return {
      icon: "\u2192",
      title: shown ? `Read ${shown}` : "Read file",
      lines: shown ? [`Path: ${shown}`] : [],
    };
  }
  if (kind === "edit") {
    return {
      icon: "\u2192",
      title: shown ? `Write ${shown}` : "Write file",
      lines: shown ? [`Path: ${shown}`] : [],
    };
  }
  if (kind === "webfetch") {
    return {
      icon: "%",
      title: shown ? `Web fetch ${shown}` : "Network fetch",
      lines: shown ? [`URL: ${shown}`] : [],
    };
  }
  if (kind === "mcp") {
    return {
      icon: "\u2699",
      title: shown ? `MCP ${shown}` : "MCP tool",
      lines: [req.title || "invoke external MCP tool"],
    };
  }
  if (req.kind === "other" && /trust|hook/i.test(req.title ?? "")) {
    return {
      icon: "\u26a0",
      title: req.title || "Trust decision",
      lines: target.split("\n").filter((l) => l.trim() !== ""),
    };
  }
  return {
    icon: "\u2699",
    title: req.title || `Allow ${kind}`,
    lines: target ? [target] : [],
  };
}

/** Lines shown after the user picks "always" (OpenCode `permissionAlwaysLines`). */
export function permissionAlwaysLines(kind: string, target: string): string[] {
  if (target === "" || target === "*") {
    return [`This session will remember yes for ${kind} until the grant expires.`];
  }
  return [
    "This session will remember yes for the exact target below until the grant expires.",
    `- ${target}`,
  ];
}

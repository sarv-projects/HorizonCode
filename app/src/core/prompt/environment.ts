/**
 * The dynamic environment block, rendered at request time. Everything that can
 * differ between sessions lives here so the static sections stay a cacheable
 * prefix. Every input is injectable, so the output is deterministic in tests.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export interface EnvironmentInfo {
  workspace: string;
  /** Rendered as YYYY-MM-DD; an invalid date renders as an empty stamp. */
  today: Date;
  /** `process.platform`-style OS label, with an optional arch. */
  os: string;
  /** Login shell name (basename), or "unknown". */
  shell: string;
  isGitRepo: boolean;
  /** "trusted" (sandboxed Rust kernel) or "untrusted" (in-process fallback). */
  kernelMode: string;
  planMode: boolean;
  /** Names of the tools actually visible to the model this request, in registry order. */
  tools: readonly string[];
}

/** True when `dir` or an ancestor contains a `.git` entry. */
export function insideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function detectShell(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SHELL;
  return typeof raw === "string" && raw !== "" ? path.basename(raw) : "unknown";
}

export function renderEnvironment(info: EnvironmentInfo): string {
  const stamp = Number.isNaN(info.today.getTime()) ? "" : info.today.toISOString().slice(0, 10);
  const tools = info.tools.length > 0 ? info.tools.join(", ") : "(none)";
  return [
    "Environment:",
    `- Working directory (workspace): ${info.workspace}`,
    `- Date: ${stamp}`,
    `- OS: ${info.os}; shell: ${info.shell}`,
    `- Git repository: ${info.isGitRepo ? "yes" : "no"}`,
    `- Kernel: ${info.kernelMode}${info.kernelMode === "untrusted" ? " (in-process fallback, weaker isolation)" : ""}`,
    `- Plan mode: ${info.planMode ? "on (write and edit are staged for user review)" : "off"}`,
    `- Tools: ${tools}`,
  ].join("\n");
}

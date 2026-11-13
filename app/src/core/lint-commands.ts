/**
 * F-3 reduced: user-supplied per-extension lint commands with `{file}` substitution
 * and `path:line` output parsing (aider-style; no tree-sitter).
 */

import { extname } from "node:path";

export interface LintCommandEntry {
  /** Dotless extensions, or `"*"` catch-all (lowest priority after specifics). */
  extensions: string[];
  /** Shell command; `{file}` is replaced with the absolute path (quoted). */
  command: string;
}

export interface LintConfig {
  commands: LintCommandEntry[];
  rejected: string[];
}

function normExt(ext: string): string {
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}

export function parseLintCommandEntry(raw: unknown, index: number): LintCommandEntry | string {
  const where = `lint.commands[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `${where} must be an object`;
  }
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.extensions) || row.extensions.length === 0) {
    return `${where}.extensions must be a non-empty array of strings`;
  }
  const extensions: string[] = [];
  for (const item of row.extensions as unknown[]) {
    if (typeof item !== "string" || item.trim() === "") return `${where}.extensions must be strings`;
    extensions.push(normExt(item));
  }
  if (typeof row.command !== "string" || row.command.trim() === "") {
    return `${where}.command must be a non-empty string`;
  }
  if (!row.command.includes("{file}")) {
    return `${where}.command must contain {file}`;
  }
  return { extensions, command: row.command.trim() };
}

export function parseLintConfig(value: unknown): LintConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return { commands: [], rejected: ["lint must be an object with a `commands` array"] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.commands === undefined) return undefined;
  if (!Array.isArray(raw.commands)) return { commands: [], rejected: ["lint.commands must be an array"] };
  const commands: LintCommandEntry[] = [];
  const rejected: string[] = [];
  (raw.commands as unknown[]).forEach((item, index) => {
    const parsed = parseLintCommandEntry(item, index);
    if (typeof parsed === "string") rejected.push(parsed);
    else commands.push(parsed);
  });
  if (commands.length === 0 && rejected.length === 0) return undefined;
  return { commands, rejected };
}

/** Pick the most specific lint command for a file path. `*` is catch-all. */
export function resolveLintCommand(absPath: string, config: LintConfig | undefined): LintCommandEntry | undefined {
  if (config === undefined || config.commands.length === 0) return undefined;
  const ext = normExt(extname(absPath));
  let catchAll: LintCommandEntry | undefined;
  for (const entry of config.commands) {
    if (entry.extensions.includes("*")) {
      catchAll = entry;
      continue;
    }
    if (entry.extensions.includes(ext)) return entry;
  }
  return catchAll;
}

export function substituteLintFile(command: string, absPath: string): string {
  const quoted = JSON.stringify(absPath);
  return command.replaceAll("{file}", quoted);
}

/** Parse `filename:line[:col] message` lines (compiler-style). */
export function parseLintOutputLines(text: string): { path: string; line: number; col?: number; message: string }[] {
  const out: { path: string; line: number; col?: number; message: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^([^:]+):(\d+)(?::(\d+))?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, file, ln, col, rest] = m;
    const message = rest.trim() === "" ? "(no message)" : rest.trim();
    out.push({
      path: file,
      line: Number.parseInt(ln, 10),
      col: col !== undefined ? Number.parseInt(col, 10) : undefined,
      message,
    });
  }
  return out;
}

export async function runUserLintCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout + (stderr !== "" ? `\n${stderr}` : ""), stderr, exitCode };
}

export function formatLintFindings(
  relPath: string,
  findings: { path: string; line: number; col?: number; message: string }[],
): string {
  if (findings.length === 0) return `${relPath}: no issues from user lint command`;
  const lines = findings.map((f) => {
    const col = f.col !== undefined ? `:${f.col}` : "";
    return `${f.path}:${f.line}${col} error ${f.message}`;
  });
  return `${relPath}: ${findings.length} error(s) from user lint\n${lines.join("\n")}`;
}

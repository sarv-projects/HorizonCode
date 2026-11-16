/**
 * F-3 reduced: user-supplied per-extension lint commands with `{file}` substitution
 * and `path:line` output parsing (aider-style; no tree-sitter).
 *
 * Catch-all policy (part of the ruling draft for the 462 residual): exactly one
 * `"*"` catch-all is expected. When several are configured the choice is still
 * deterministic - the LAST catch-all wins. `parseLintConfig` records a `rejected`
 * diagnostic naming every catch-all index so `config check` surfaces the
 * ambiguity, and the `lint` tool echoes the same warning in its output.
 */

import { extname } from "node:path";
import type { SandboxSpawnKernel } from "../contracts";
import { spawnOwned } from "./owned-spawn";

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

/** Cap findings from a single linter run so a noisy linter cannot flood the prompt. */
export const LINT_OUTPUT_MAX_FINDINGS = 200;

export interface LintFinding {
  path: string;
  line: number;
  col?: number;
  message: string;
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

/**
 * Clear diagnostic for the ambiguous-catch-all case. Returns `undefined` when
 * there are zero or exactly one catch-all entries (the supported case).
 */
export function lintCatchAllDiagnostic(commands: readonly LintCommandEntry[]): string | undefined {
  const indices: number[] = [];
  commands.forEach((entry, index) => {
    if (entry.extensions.includes("*")) indices.push(index);
  });
  if (indices.length < 2) return undefined;
  const last = indices[indices.length - 1]!;
  return `lint.commands: ${indices.length} catch-all ("*") entries at indices ${indices.join(", ")}; exactly one is expected; the last one (index ${last}) wins deterministically`;
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
  const catchAllIssue = lintCatchAllDiagnostic(commands);
  if (catchAllIssue !== undefined) rejected.push(catchAllIssue);
  if (commands.length === 0 && rejected.length === 0) return undefined;
  return { commands, rejected };
}

/**
 * Pick the most specific lint command for a file path. `*` is the catch-all.
 *
 * Deterministic policy: a specific extension match always wins (first one in
 * config order), regardless of where a catch-all sits. If no specific match
 * exists, the LAST catch-all wins. Multiple catch-alls are reported by
 * `lintCatchAllDiagnostic` so the ambiguity is never silent.
 */
export function resolveLintCommand(absPath: string, config: LintConfig | undefined): LintCommandEntry | undefined {
  if (config === undefined || config.commands.length === 0) return undefined;
  const ext = normExt(extname(absPath));
  let catchAll: LintCommandEntry | undefined;
  for (const entry of config.commands) {
    if (entry.extensions.includes("*")) {
      // Documented last-wins assignment (see lintCatchAllDiagnostic).
      catchAll = entry;
      continue;
    }
    if (entry.extensions.includes(ext)) return entry;
  }
  return catchAll;
}

/**
 * POSIX single-quote a path so it becomes one inert shell word: spaces, `$`,
 * backticks, quotes and backslashes are all literal. This matters because the
 * file path can originate in a tool argument, while the command template is
 * user config; substitution must never let a path break out of its quotes.
 */
export function shellQuotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function substituteLintFile(command: string, absPath: string): string {
  return command.replaceAll("{file}", shellQuotePath(absPath));
}

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * A finding head: `path:line[:col]`. The path may carry a Windows drive prefix
 * (`C:\...`); it otherwise cannot contain a colon. Kept global so one output
 * line can yield several findings (e.g. `a.ts:3:1 error one; b.ts:5:2 error two`).
 */
const FINDING_HEAD_RE = /((?:[A-Za-z]:)?[^\s:;,]+):(\d+)(?::(\d+))?/g;

/** A whitespace-separated head is only trusted as a second path if it looks like one. */
function isPathLike(token: string): boolean {
  return /[./\\]/.test(token) || /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * Parse `filename:line[:col] message` lines (compiler-style).
 *
 * Handles Windows drive paths, ANSI colour codes, several findings on one line
 * (separated by `;`/`,` or by whitespace before a path-like token), and caps
 * the total number of findings via `opts.maxFindings`.
 */
export function parseLintOutputLines(
  text: string,
  opts?: { maxFindings?: number },
): LintFinding[] {
  const cap = Math.max(1, opts?.maxFindings ?? LINT_OUTPUT_MAX_FINDINGS);
  const out: LintFinding[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_RE, "").trim();
    if (line === "") continue;

    const heads: { start: number; end: number; path: string; line: number; col?: number }[] = [];
    FINDING_HEAD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FINDING_HEAD_RE.exec(line)) !== null && heads.length < cap) {
      if (m.index > 0) {
        const before = line[m.index - 1]!;
        const strong = before === ";" || before === ",";
        if (!strong && !(/\s/.test(before) && isPathLike(m[1]!))) continue;
      }
      heads.push({
        start: m.index,
        end: m.index + m[0].length,
        path: m[1]!,
        line: Number.parseInt(m[2]!, 10),
        col: m[3] !== undefined ? Number.parseInt(m[3], 10) : undefined,
      });
    }
    if (heads.length === 0) continue;

    for (let i = 0; i < heads.length; i++) {
      const head = heads[i]!;
      const message = line
        .slice(head.end, i + 1 < heads.length ? heads[i + 1]!.start : line.length)
        .replace(/^[\s;,:]+/, "")
        .replace(/[\s;,]+$/, "")
        .trim();
      out.push({
        path: head.path,
        line: head.line,
        col: head.col,
        message: message === "" ? "(no message)" : message,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export interface RunUserLintSpawnOptions {
  cwd: string;
  stateDir: string;
  kernel?: SandboxSpawnKernel;
}

/** User lint runs through the single owned spawn path (NF-071). */
export async function runUserLintCommand(
  command: string,
  opts: RunUserLintSpawnOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { proc } = await spawnOwned(["/bin/sh", "-c", command], {
    stateDir: opts.stateDir,
    cwd: opts.cwd,
    label: "lint-user",
    detached: true,
    longLived: false,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    sandboxWrap: "auto",
    sandboxMode: "workspace-write",
    kernel: opts.kernel,
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
  findings: LintFinding[],
): string {
  if (findings.length === 0) return `${relPath}: no issues from user lint command`;
  const lines = findings.map((f) => {
    const col = f.col !== undefined ? `:${f.col}` : "";
    return `${f.path}:${f.line}${col} error ${f.message}`;
  });
  return `${relPath}: ${findings.length} error(s) from user lint\n${lines.join("\n")}`;
}

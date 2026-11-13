/**
 * Reduced plan-mode shell mutation detector (cline command-guard slice).
 *
 * No shell interpreter: masks quotes/comments, splits compounds via shell-split,
 * peels common wrappers, and blocks in-place edits, redirect writes, and tee
 * outside safe sinks. Pure TS, zero deps.
 */

import { analyzeShellCompound } from "./shell-split";

const WRAPPERS = new Set(["sudo", "doas", "env", "timeout", "xargs", "command", "nohup", "time", "nice", "stdbuf"]);

function maskQuotesAndComments(segment: string): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < segment.length) {
    const c = segment[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else out += " ";
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(segment[i - 1]!))) break;
    if (c === "'" || c === '"') {
      quote = c;
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function isAllowedRedirectTarget(target: string): boolean {
  const t = target.toLowerCase();
  if (t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr" || t === "/dev/tty") return true;
  if (t === "nul:" || t === "nul") return true;
  if (t === "/tmp" || t.startsWith("/tmp/") || t === "/var/tmp" || t.startsWith("/var/tmp/")) return true;
  if (t.includes("..")) return false;
  return false;
}

function redirectWriteReason(masked: string): string | undefined {
  const re = /(?:^|\s)(?:\d*>>?|&>>?|&>)\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const target = m[1]!;
    if (!isAllowedRedirectTarget(target)) return `redirect write to ${target}`;
  }
  return undefined;
}

function tokenizeMasked(masked: string): string[] {
  return masked.trim().split(/\s+/).filter((t) => t !== "");
}

function skipWrapperOptions(wrapper: string, tokens: string[], start: number): number {
  let i = start;
  if (wrapper === "env") {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    return i;
  }
  if (wrapper === "timeout") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    if (i < tokens.length && /^[\d.]+[smhd]?$/.test(tokens[i]!)) i++;
    return i;
  }
  if (wrapper === "xargs" || wrapper === "sudo" || wrapper === "doas") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    return i;
  }
  return i;
}

function peelWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i]!.toLowerCase();
    if (!WRAPPERS.has(head)) break;
    i = skipWrapperOptions(head, tokens, i + 1);
  }
  return tokens.slice(i);
}

function sedInPlace(tokens: string[]): boolean {
  const cmd = tokens[0]?.toLowerCase();
  if (cmd !== "sed" && cmd !== "gsed") return false;
  return tokens.some((t) => t === "-i" || t.startsWith("-i"));
}

function perlInPlace(tokens: string[]): boolean {
  if (tokens[0]?.toLowerCase() !== "perl") return false;
  let hasI = false;
  let hasP = false;
  for (const t of tokens) {
    if (!t.startsWith("-")) continue;
    const body = t.slice(1);
    if (body.includes("i")) hasI = true;
    if (body.includes("p")) hasP = true;
    if (t === "-i") hasI = true;
  }
  return hasI || (hasP && tokens.some((t) => t === "-i" || t.startsWith("-i")));
}

function teeWriteReason(tokens: string[]): string | undefined {
  if (tokens[0]?.toLowerCase() !== "tee") return undefined;
  for (const arg of tokens.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (!isAllowedRedirectTarget(arg)) return `tee write to ${arg}`;
  }
  return undefined;
}

function checkSegment(segment: string): string | undefined {
  const masked = maskQuotesAndComments(segment);
  const redirect = redirectWriteReason(masked);
  if (redirect !== undefined) return redirect;
  const tokens = peelWrappers(tokenizeMasked(masked));
  if (tokens.length === 0) return "empty command segment";
  if (sedInPlace(tokens)) return "sed -i in-place edit";
  if (perlInPlace(tokens)) return "perl in-place edit";
  const tee = teeWriteReason(tokens);
  if (tee !== undefined) return tee;
  return undefined;
}

/** Short reason when a command mutates disk, or undefined when it looks read-only. */
export function findPlanModeMutatingCommand(command: string): string | undefined {
  const analysis = analyzeShellCompound(command);
  if (analysis.ok === false) return `unparsed shell (${analysis.reason})`;
  for (const seg of analysis.segments) {
    const reason = checkSegment(seg.text);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Model-facing refusal for plan-mode shell, or undefined to allow investigation commands. */
export function planModeShellRefusal(command: string): string | undefined {
  const reason = findPlanModeMutatingCommand(command);
  if (reason === undefined) return undefined;
  return (
    `plan mode: shell refused (${reason}); use write/edit to stage file changes, ` +
    "or exit plan mode to run mutating commands"
  );
}

/**
 * Reduced compound-shell splitter (ADAPT grok bash_command_splitting).
 *
 * Splits a line on top-level `&&`, `||`, `;`, and `|` outside quotes for
 * approval display, coarse per-segment risk, and per-segment guard checks.
 * Anything we cannot parse honestly (substitution, heredocs, subshells,
 * unclosed quotes) is rejected.
 */

import type { GuardAction, GuardKind } from "../contracts";
import { scanShellCommand } from "./shell-scan";

export type SegmentRisk = "low" | "medium" | "high";

export type ShellSegment = {
  /** One executable fragment (trimmed). */
  text: string;
  /** Operator before this segment (absent on the first). */
  joiner?: "&&" | "||" | ";" | "|";
  risk: SegmentRisk;
};

export type ShellCompoundAnalysis =
  | { ok: true; segments: ShellSegment[]; compound: boolean }
  | { ok: false; reason: string };

const DENY_FRAGMENT = [/\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, /\bmkfs\b/i, /\bdd\s+if=.*\bof=\/dev\//i, /:\(\)\s*\{/];
const HIGH_FRAGMENT = [/\bsudo\b/i, /\bchmod\b/i, /\bcurl\b[^|]*\|\s*(sh|bash)\b/i, /\bgit\s+push\b.*--force/i, /\bwget\b/i, /\bcurl\b/i];

/**
 * Group C (grok exec_risk ADAPT, zero runtime dependency): data-driven wrapper
 * heads that escalate risk. Pure/lexical, NOT tree-sitter AST. Risk-INCREASE
 * only — a scorer never lowers a risk below the existing segment heuristics,
 * and it is advisory (the Guard/execpolicy allow path is untouched).
 */
const EXEC_RISK_VEHICLES: readonly { head: RegExp; reason: string }[] = [
  { head: /(?:^|\s)(?:sh|bash|zsh|dash)\b/i, reason: "shell interpreter vehicle" },
  { head: /(?:^|\s)(?:env|nice|timeout|nohup|ionice|setsid)\b/i, reason: "execution wrapper vehicle" },
  { head: /(?:^|\s)(?:npx|node|python3?|ruby|perl)\b/i, reason: "script-runtime vehicle" },
  { head: /(?:^|\s)(?:docker|podman|kubectl)\b/i, reason: "container vehicle" },
];

export interface ExecRiskResult {
  risk: SegmentRisk;
  reason: string;
}

/** Lexical risk score over wrapper/vehicle heads; never lowers risk. */
export function execRiskScore(text: string): ExecRiskResult {
  const t = text.trim();
  for (const rule of EXEC_RISK_VEHICLES) {
    if (rule.head.test(t)) return { risk: "high", reason: rule.reason };
  }
  return { risk: "medium", reason: "no high-risk vehicle head detected" };
}

/** Coarse risk for one segment (mirrors approval-card heuristics). */
export function segmentRisk(text: string): SegmentRisk {
  const t = text.trim();
  if (t === "") return "medium";
  if (DENY_FRAGMENT.some((re) => re.test(t)) || /[|;&]|>\s*\S/.test(t)) return "high";
  if (HIGH_FRAGMENT.some((re) => re.test(t))) return "high";
  if (/\b(rm|chmod|chown|dd|mkfs|curl|wget|git\s+push|kill)\b/i.test(t)) return "high";
  if (/^(sh|bash|zsh|dash)$/i.test(t)) return "high";
  // P2 Static AST escalation: opaque/dynamic execution (eval, source, exec,
  // $CMD, ${!var}, PowerShell iex / Invoke-Expression / & $var) always escalates to high.
  if (scanShellCommand(t).opaque) return "high";
  // Group C: data-driven vehicle/wrapper heads may ESCALATE to high, never
  // lower a risk the existing heuristics already assigned.
  return execRiskScore(t).risk;
}

export function maxSegmentRisk(segments: readonly ShellSegment[]): SegmentRisk {
  let risk: SegmentRisk = "low";
  for (const s of segments) {
    if (s.risk === "high") return "high";
    if (s.risk === "medium") risk = "medium";
  }
  return risk;
}

function unparsedReason(command: string): string | undefined {
  const s = command.trim();
  if (s === "") return "empty command";
  if (/`/.test(s)) return "backtick command substitution";
  if (/\$\(/.test(s)) return "$(…) command substitution";
  if (/\$\{/.test(s)) return "${…} parameter expansion";
  if (/\$\(\(/.test(s)) return "$((…)) arithmetic expansion";
  if (/<<-?\s*\S/.test(s)) return "heredoc";
  if (/\(/.test(s) || /\)/.test(s)) return "subshell parentheses";
  return undefined;
}

type RawPiece = { text: string; joiner?: ShellSegment["joiner"] };

function splitTopLevel(command: string): { pieces: RawPiece[] } | { reason: string } {
  const out: RawPiece[] = [];
  let buf = "";
  let pendingJoiner: ShellSegment["joiner"] | undefined;
  let i = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushSegment = (): void => {
    if (buf.trim() !== "") out.push({ text: buf, joiner: pendingJoiner });
    buf = "";
    pendingJoiner = undefined;
  };

  while (i < command.length) {
    const c = command[i]!;
    if (escaped) {
      buf += c;
      escaped = false;
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === "\\" && quote === '"') {
        escaped = true;
        buf += c;
        i++;
        continue;
      }
      if (c === quote) quote = null;
      buf += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      buf += c;
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      return { reason: "newline command separator" };
    }
    if (command.startsWith("<<<", i)) {
      return { reason: "here-string <<<" };
    }
    if (command.startsWith("|&", i)) {
      return { reason: "pipe-stderr operator |&" };
    }
    if (c === "{" || c === "}") {
      return { reason: "brace group / expansion" };
    }
    if (command.startsWith("&&", i)) {
      pushSegment();
      pendingJoiner = "&&";
      i += 2;
      continue;
    }
    if (c === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      // Allow fd duplications (`2>&1`, `>&2`, `<&0`) and combined redirects (`&>`, `&>>`).
      if (prev !== ">" && prev !== "<" && next !== ">") {
        return { reason: "background operator &" };
      }
      buf += c;
      i++;
      continue;
    }
    if (command.startsWith("||", i)) {
      pushSegment();
      pendingJoiner = "||";
      i += 2;
      continue;
    }
    if (c === ";") {
      pushSegment();
      pendingJoiner = ";";
      i++;
      continue;
    }
    if (c === "|" && command[i + 1] !== "|") {
      pushSegment();
      pendingJoiner = "|";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (quote !== null) return { reason: "unclosed quote or escape" };
  if (escaped) return { reason: "unclosed quote or escape" };
  pushSegment();
  return { pieces: out };
}

/** Parse a shell command line for compound segments, or refuse when unsafe to split. */
export function analyzeShellCompound(command: string): ShellCompoundAnalysis {
  const reason = unparsedReason(command);
  if (reason !== undefined) return { ok: false, reason };

  const raw = splitTopLevel(command);
  if ("reason" in raw) return { ok: false, reason: raw.reason };

  const segments: ShellSegment[] = [];
  for (const piece of raw.pieces) {
    const text = piece.text.trim();
    if (text === "") continue;
    segments.push({
      text,
      joiner: piece.joiner,
      risk: segmentRisk(text),
    });
  }
  if (segments.length === 0) return { ok: false, reason: "empty command" };
  return { ok: true, segments, compound: segments.length > 1 };
}

/** Human lines for the approval card (segment index, joiner, risk). */
export function shellCompoundPresentationLines(
  analysis: ShellCompoundAnalysis,
  opts?: { savedShellTargets?: ReadonlySet<string> },
): string[] {
  if (analysis.ok === false) return [`dynamic — cannot split (${analysis.reason})`];
  if (!analysis.compound) return [];
  const lines: string[] = ["compound command (per segment):"];
  for (let i = 0; i < analysis.segments.length; i++) {
    const seg = analysis.segments[i]!;
    const prefix = seg.joiner !== undefined ? `${seg.joiner} ` : "";
    const saved = opts?.savedShellTargets?.has(seg.text) ? " (saved allow)" : "";
    lines.push(`${i + 1}. [${seg.risk}] ${prefix}${seg.text}${saved}`);
  }
  return lines;
}

export function shellCompoundRefusal(command: string): string | undefined {
  const analysis = analyzeShellCompound(command);
  if (analysis.ok !== false) return undefined;
  return `HZ_PRECONDITION_FAILED: shell command cannot be split safely (${analysis.reason}); refused before approval`;
}

/**
 * Guard checks for compound shell: one `shell.exec` action per parsed segment
 * (single segment or unparsed → one action on the full command).
 */
export function guardActionsForShellCommand(command: string, template: GuardAction): GuardAction[] {
  if (template.kind !== "shell.exec") return [template];
  const analysis = analyzeShellCompound(command);
  if (analysis.ok === false || !analysis.compound) return [template];
  return analysis.segments.map((seg) => ({ ...template, target: seg.text }));
}

/**
 * Grant / saved-allow targets for a shell row: compound lines expand to one
 * target per parsed segment so per-segment guard checks match hydration (396).
 */
export function shellSavedGrantTargets(kind: GuardKind, target: string): string[] {
  const t = target.trim();
  if (t === "" || t.endsWith("*")) return [];
  if (kind !== "shell.exec") return [t];
  const analysis = analyzeShellCompound(t);
  if (analysis.ok !== true || !analysis.compound) return [t];
  return analysis.segments.map((seg) => seg.text);
}

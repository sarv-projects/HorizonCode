/**
 * Reduced compound-shell splitter (ADAPT grok bash_command_splitting).
 *
 * Splits a line on top-level `&&`, `||`, `;`, and `|` outside quotes for
 * approval display, coarse per-segment risk, and per-segment guard checks.
 * Anything we cannot parse honestly (substitution, heredocs, subshells,
 * unclosed quotes) is rejected.
 */

import type { GuardAction } from "../contracts";

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

/** Coarse risk for one segment (mirrors approval-card heuristics). */
export function segmentRisk(text: string): SegmentRisk {
  const t = text.trim();
  if (t === "") return "medium";
  if (DENY_FRAGMENT.some((re) => re.test(t)) || /[|;&]|>\s*\S/.test(t)) return "high";
  if (HIGH_FRAGMENT.some((re) => re.test(t))) return "high";
  if (/\b(rm|chmod|chown|dd|mkfs|curl|wget|git\s+push|kill)\b/i.test(t)) return "high";
  if (/^(sh|bash|zsh|dash)$/i.test(t)) return "high";
  return "medium";
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

function splitTopLevel(command: string): RawPiece[] | null {
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
    if (command.startsWith("&&", i)) {
      pushSegment();
      pendingJoiner = "&&";
      i += 2;
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
  if (quote !== null) return null;
  if (escaped) return null;
  pushSegment();
  return out;
}

/** Parse a shell command line for compound segments, or refuse when unsafe to split. */
export function analyzeShellCompound(command: string): ShellCompoundAnalysis {
  const reason = unparsedReason(command);
  if (reason !== undefined) return { ok: false, reason };

  const raw = splitTopLevel(command);
  if (raw === null) return { ok: false, reason: "unclosed quote or escape" };

  const segments: ShellSegment[] = [];
  for (const piece of raw) {
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
export function shellCompoundPresentationLines(analysis: ShellCompoundAnalysis): string[] {
  if (analysis.ok === false) return [`dynamic — cannot split (${analysis.reason})`];
  if (!analysis.compound) return [];
  const lines: string[] = ["compound command (per segment):"];
  for (let i = 0; i < analysis.segments.length; i++) {
    const seg = analysis.segments[i]!;
    const prefix = seg.joiner !== undefined ? `${seg.joiner} ` : "";
    lines.push(`${i + 1}. [${seg.risk}] ${prefix}${seg.text}`);
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

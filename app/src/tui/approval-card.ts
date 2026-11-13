/**
 * approval-card.ts : the bordered single-key approval card (rich TTY only).
 *
 * Pure rendering: `approvalCard` returns the card lines for a request, and
 * `keyChoice` maps one keypress to an answer. The interactive loop owns the
 * key reading and the type-ahead guard; the line-based prompt in approval.ts
 * stays the fallback for every other situation.
 */

import { analyzeShellCompound, maxSegmentRisk } from "../core/shell-split";
import { formatToolEffectLinkage } from "./cards";
import { bold, dim, paint, sanitizeText, truncate, visibleWidth } from "./style";

export type Risk = "low" | "medium" | "high";
export type KeyAnswer = "y" | "n" | "a";

export interface ApprovalCardInput {
  /** The tool or guard kind, e.g. `shell.exec`. */
  kind: string;
  title: string;
  /** Optional presentation icon prefix (OpenCode-style). */
  icon?: string;
  /** Extra lines between tool row and risk (e.g. path / command summary). */
  presentationLines?: string[];
  /** Arguments summary: the command, path or URL. */
  detail?: string;
  guardian?: string;
  /** EffectHost / lease / dispatch-tool linkage (docs/28 ruling 254). */
  effectId?: string;
  leaseId?: string;
  tool?: string;
  /** Terminal columns available; the card never exceeds it. */
  width: number;
  /** False selects ASCII borders for non-UTF-8 locales. */
  unicode?: boolean;
  /** Whether an "always" answer can be remembered (a target exists). */
  canAlways?: boolean;
}

/** Coarse risk of a guard kind; shell and unknown authority is highest. */
export function riskOf(kind: string, detail = ""): Risk {
  if (kind === "fs.read") return "low";
  if (kind === "shell.exec") {
    const analysis = analyzeShellCompound(detail);
    if (analysis.ok) return maxSegmentRisk(analysis.segments) as Risk;
    return "high";
  }
  if (kind === "net.fetch" || kind === "mcp.invoke" || kind === "spawn") return "high";
  return "medium";
}

function riskPaint(risk: Risk, text: string): string {
  return risk === "high" ? paint("err", text) : risk === "medium" ? paint("warn", text) : paint("ok", text);
}

/** Dim linkage line for approvals (`effect … · lease … · tool …`). */
export function formatApprovalLinkage(input: {
  effectId?: string;
  leaseId?: string;
  tool?: string;
}): string {
  const bits: string[] = [];
  const effectPart = formatToolEffectLinkage({ effectId: input.effectId });
  if (effectPart !== "") bits.push(effectPart);
  const lid = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
  if (lid !== "") bits.push(`lease ${sanitizeText(lid).slice(0, 8)}`);
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (tool !== "") bits.push(`tool ${sanitizeText(tool)}`);
  return bits.join(" \u00b7 ");
}

/** The key legend: keys bold, labels dim. */
export function keyLegend(canAlways = true): string {
  const parts = [bold("y") + dim(" yes"), bold("n") + dim(" no")];
  if (canAlways) parts.push(bold("a") + dim(" always this session"));
  parts.push(bold("Esc") + dim(" deny"));
  return parts.map((p, i) => (i === 0 ? "" : dim("  ")) + p).join("");
}

export function approvalCard(input: ApprovalCardInput): string[] {
  const u = input.unicode !== false;
  const [tl, tr, bl, br, h, v] = u ? ["\u256d", "\u256e", "\u2570", "\u256f", "\u2500", "\u2502"] : ["+", "+", "+", "+", "-", "|"];
  const width = Math.max(24, Math.floor(input.width));
  const inner = width - 4;
  const risk = riskOf(input.kind, input.detail ?? "");
  const rows: string[] = [];
  const icon = (input.icon ?? "").trim();
  rows.push(dim("tool ") + (icon !== "" ? icon + " " : "") + bold(input.kind));
  const pres = (input.presentationLines ?? []).filter((l) => l.trim() !== "");
  if (pres.length > 0) rows.push(...pres.map((l) => truncate(l, inner)));
  const detail = (input.detail ?? "").trim();
  if (detail !== "") {
    const all = detail.split("\n");
    const shown = all.slice(0, 4).map((l) => (u ? "\u276f " : "> ") + truncate(l, inner - 2));
    rows.push(...shown);
    if (all.length > 4) rows.push(dim(`${u ? "\u2026" : "..."} +${all.length - 4} lines`));
  }
  rows.push(dim("risk ") + riskPaint(risk, risk));
  const linkage = formatApprovalLinkage({
    effectId: input.effectId,
    leaseId: input.leaseId,
    tool: input.tool,
  });
  if (linkage !== "") rows.push(dim(truncate(linkage, inner)));
  if (input.guardian) rows.push(dim(truncate(input.guardian, inner)));
  rows.push(keyLegend(input.canAlways !== false));

  const head = ` ${u ? "\u26a0" : "!"} Approve ${truncate(input.title, Math.max(8, inner - 14))}? `;
  const top = paint("warn", tl + h) + paint("warn", bold(head)) + paint("warn", h.repeat(Math.max(0, width - 3 - visibleWidth(head))) + tr);
  const out = [top];
  for (const row of rows) {
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
    out.push(paint("warn", v) + " " + row + pad + " " + paint("warn", v));
  }
  out.push(paint("warn", bl + h.repeat(width - 2) + br));
  return out;
}

/** Map one keypress (readline key shape) to an answer; undefined means ignore. */
export function keyChoice(str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): KeyAnswer | undefined {
  if (key?.ctrl && key.name === "c") return "n";
  if (key?.name === "escape" || key?.name === "return" || key?.name === "enter") return "n";
  const ch = (str ?? "").toLowerCase();
  if (key?.ctrl) return undefined;
  if (ch === "y") return "y";
  if (ch === "n") return "n";
  if (ch === "a") return "a";
  return undefined;
}

/**
 * approval-card.ts : the bordered single-key approval card (rich TTY only).
 *
 * Pure rendering: `approvalCard` returns the card lines for a request, and
 * `keyChoice` maps one keypress to an answer. The interactive loop owns the
 * key reading and the type-ahead guard; the line-based prompt in approval.ts
 * stays the fallback for every other situation.
 */

import { analyzeShellCompound, maxSegmentRisk } from "../core/shell-split";
import { formatGrantRemainingForApproval } from "./grant-ttl";
import { formatToolEffectLinkage } from "./cards";
import { permissionAlwaysConfirmLines, permissionRejectSteeringLines } from "./permission-presentation";
import { bold, dim, paint, sanitizeText, truncate, visibleWidth } from "./style";

export type Risk = "low" | "medium" | "high";
export type KeyAnswer = "y" | "n" | "a";

/**
 * 3-stage OpenCode-style approval flow:
 * - `permission` (Stage 1): allow once (`y`), allow always (`a` -> Stage 2), reject/steer (`n`/`r` -> Stage 3), Esc/Ctrl+C decline.
 * - `always_confirm` (Stage 2): displays the exact pattern/scope to be saved before confirming (`y`/`Enter`) or returning (`Esc`/`n`).
 * - `reject_steer` (Stage 3): optional steering instruction input (`Enter` with text -> `rejected_with_steering`; `Enter` empty -> plain `declined`; `Esc` -> back to Stage 1).
 */
export type ApprovalStage = "permission" | "always_confirm" | "reject_steer";

export interface ApprovalStageState {
  readonly stage: ApprovalStage;
  readonly canAlways: boolean;
  /** Exact permission pattern/scope that will be saved on Stage 2 confirm. */
  readonly alwaysPattern?: string;
  /** Live user-typed steering instruction in Stage 3. */
  readonly steeringInput: string;
}

export type ApprovalStageResolution =
  | { readonly kind: "approved"; readonly scope: "once" | "always" }
  | { readonly kind: "declined" }
  | { readonly kind: "rejected_with_steering"; readonly feedback: string };

export type ApprovalStageStepResult =
  | { readonly done: false; readonly state: ApprovalStageState }
  | { readonly done: true; readonly state: ApprovalStageState; readonly resolution: ApprovalStageResolution };

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
  /** Session grant TTL in minutes (approval card footnote). */
  grantTtlMinutes?: number;
  /** When a grant already covers this target, minutes left (display at prompt time). */
  grantActiveRemainingMinutes?: number;
  /** Prefer over `grantActiveRemainingMinutes` for live ticking countdown copy. */
  grantActiveRemainingMs?: number;
  /** Active stage in the 3-stage flow; defaults to `"permission"` (legacy 1-stage rendering). */
  stage?: ApprovalStage;
  /** Exact permission pattern/scope displayed in Stage 2 (`always_confirm`). */
  alwaysPattern?: string;
  /** Current steering text buffer displayed in Stage 3 (`reject_steer`). */
  steeringInput?: string;
  /** Human-principal approval signing posture (Track A4). */
  principalMode?: "ed25519" | "parent" | "unsigned";
  /** Short fingerprint of the local ed25519 principal public key when signed. */
  principalKeyFingerprint?: string;
}

/** Format the human-principal trust badge line for approval cards (Track A4). */
export function formatPrincipalBadge(
  mode?: "ed25519" | "parent" | "unsigned",
  fingerprint?: string,
): string {
  if (mode === undefined) return "";
  if (mode === "ed25519") {
    const fp = sanitizeText(fingerprint ?? "").replace(/\s+/g, "").trim();
    return fp !== "" ? `principal: ed25519 (${fp.slice(0, 16)})` : "principal: ed25519";
  }
  return "principal: parent-pipe (unsigned)";
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
export function keyLegend(canAlways = true, grantTtlMinutes = 15): string {
  const parts = [bold("y") + dim(" yes"), bold("n") + dim(" no")];
  if (canAlways) {
    const label = grantTtlMinutes > 0 ? ` always this session (${grantTtlMinutes}m grant)` : " always this session";
    parts.push(bold("a") + dim(label));
  }
  parts.push(bold("Esc") + dim(" deny"));
  return parts.map((p, i) => (i === 0 ? "" : dim("  ")) + p).join("");
}

export function approvalCard(input: ApprovalCardInput): string[] {
  const u = input.unicode !== false;
  const [tl, tr, bl, br, h, v] = u ? ["\u256d", "\u256e", "\u2570", "\u256f", "\u2500", "\u2502"] : ["+", "+", "+", "+", "-", "|"];
  const width = Math.max(24, Math.floor(input.width));
  const inner = width - 4;
  const safeKind = sanitizeText(input.kind).replace(/\s+/g, " ").trim() || "other";
  const detail = sanitizeText(input.detail ?? "").trim();
  const safeTitle = sanitizeText(input.title).replace(/\s+/g, " ").trim() || "this action";
  const stage = input.stage ?? "permission";
  const ttlMin = input.grantTtlMinutes ?? 15;

  if (stage === "always_confirm") {
    const pattern = (input.alwaysPattern ?? detail).trim();
    const confirmLines = permissionAlwaysConfirmLines(safeKind, pattern, ttlMin * 60_000);
    const rows = [
      ...confirmLines.map((l) => truncate(l, inner)),
      stageKeyLegend("always_confirm", true, ttlMin),
    ];
    const head = ` ${u ? "\u26a0" : "!"} Confirm always (${truncate(safeKind, Math.max(6, inner - 20))}) `;
    const top = paint("warn", tl + h) + paint("warn", bold(head)) + paint("warn", h.repeat(Math.max(0, width - 3 - visibleWidth(head))) + tr);
    const out = [top];
    for (const row of rows) {
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
      out.push(paint("warn", v) + " " + row + pad + " " + paint("warn", v));
    }
    out.push(paint("warn", bl + h.repeat(width - 2) + br));
    return out;
  }

  if (stage === "reject_steer") {
    const promptLines = permissionRejectSteeringLines(safeTitle);
    const liveInput = sanitizeText(input.steeringInput ?? "").replace(/[\r\n]+/g, " ");
    const cursor = u ? "\u258c" : "_";
    const inputLine = (u ? "\u276f " : "> ") + truncate(liveInput, Math.max(4, inner - 4)) + cursor;
    const rows = [
      ...promptLines.map((l) => dim(truncate(l, inner))),
      inputLine,
      stageKeyLegend("reject_steer", false, ttlMin),
    ];
    const head = ` ${u ? "\u2717" : "x"} Reject & steer `;
    const top = paint("err", tl + h) + paint("err", bold(head)) + paint("err", h.repeat(Math.max(0, width - 3 - visibleWidth(head))) + tr);
    const out = [top];
    for (const row of rows) {
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
      out.push(paint("err", v) + " " + row + pad + " " + paint("err", v));
    }
    out.push(paint("err", bl + h.repeat(width - 2) + br));
    return out;
  }

  const risk = riskOf(safeKind, detail);
  const rows: string[] = [];
  const icon = sanitizeText(input.icon ?? "").replace(/\s+/g, " ").trim();
  rows.push(dim("tool ") + (icon !== "" ? icon + " " : "") + bold(safeKind));
  const pres = (input.presentationLines ?? [])
    .map((l) => sanitizeText(l).replace(/[\r\n]+/g, " ").trim())
    .filter((l) => l !== "");
  if (pres.length > 0) rows.push(...pres.map((l) => truncate(l, inner)));
  if (detail !== "") {
    const all = detail.split("\n");
    const shown = all.slice(0, 4).map((l) => (u ? "\u276f " : "> ") + truncate(l, inner - 2));
    rows.push(...shown);
    if (all.length > 4) rows.push(dim(`${u ? "\u2026" : "..."} +${all.length - 4} lines`));
  }
  rows.push(dim("risk ") + riskPaint(risk, risk));
  const principalBadge = formatPrincipalBadge(input.principalMode, input.principalKeyFingerprint);
  if (principalBadge !== "") {
    rows.push(
      input.principalMode === "ed25519"
        ? paint("ok", truncate(principalBadge, inner))
        : paint("warn", truncate(principalBadge, inner)),
    );
  }
  const linkage = formatApprovalLinkage({
    effectId: input.effectId,
    leaseId: input.leaseId,
    tool: input.tool,
  });
  if (linkage !== "") rows.push(dim(truncate(linkage, inner)));
  const safeGuardian = input.guardian ? sanitizeText(input.guardian).replace(/\s+/g, " ").trim() : "";
  if (safeGuardian !== "") rows.push(dim(truncate(safeGuardian, inner)));
  const grantRemMs = input.grantActiveRemainingMs;
  const grantRemMin = input.grantActiveRemainingMinutes;
  if (grantRemMs !== undefined && grantRemMs > 0) {
    rows.push(
      dim(
        truncate(
          `session grant: ${formatGrantRemainingForApproval(grantRemMs)} remaining on this exact target`,
          inner,
        ),
      ),
    );
  } else if (grantRemMin !== undefined) {
    const rem = grantRemMin;
    rows.push(
      dim(
        truncate(
          `session grant: ~${rem === 1 ? "1 minute" : `${rem} minutes`} remaining on this exact target`,
          inner,
        ),
      ),
    );
  } else if (input.canAlways !== false) {
    rows.push(dim(truncate(`grant: exact target only, expires after ${ttlMin === 1 ? "1 minute" : `${ttlMin} minutes`}`, inner)));
  }
  rows.push(keyLegend(input.canAlways !== false, ttlMin));

  const head = ` ${u ? "\u26a0" : "!"} Approve ${truncate(safeTitle, Math.max(8, inner - 14))}? `;
  const top = paint("warn", tl + h) + paint("warn", bold(head)) + paint("warn", h.repeat(Math.max(0, width - 3 - visibleWidth(head))) + tr);
  const out = [top];
  for (const row of rows) {
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
    out.push(paint("warn", v) + " " + row + pad + " " + paint("warn", v));
  }
  out.push(paint("warn", bl + h.repeat(width - 2) + br));
  return out;
}

/** Key legend for a given stage in the 3-stage approval flow. */
export function stageKeyLegend(stage: ApprovalStage, canAlways = true, grantTtlMinutes = 15): string {
  if (stage === "always_confirm") {
    return [bold("Enter/y") + dim(" confirm always"), bold("Esc/n") + dim(" back")].join(dim("  "));
  }
  if (stage === "reject_steer") {
    return [bold("Enter") + dim(" confirm reject"), bold("Esc") + dim(" back")].join(dim("  "));
  }
  return keyLegend(canAlways, grantTtlMinutes);
}

/** Build the initial Stage 1 (`permission`) state for the 3-stage approval state machine. */
export function createApprovalStageState(opts?: {
  canAlways?: boolean;
  alwaysPattern?: string;
}): ApprovalStageState {
  return {
    stage: "permission",
    canAlways: opts?.canAlways !== false,
    alwaysPattern: opts?.alwaysPattern,
    steeringInput: "",
  };
}

/**
 * Pure 3-stage keypress reducer matching OpenCode's permission prompt:
 * - Stage 1 (`permission`): `y` -> approve once, `a` -> Stage 2 (`always_confirm`), `n`/`r` -> Stage 3 (`reject_steer`), `Esc`/`Ctrl+C` -> plain decline.
 * - Stage 2 (`always_confirm`): `y`/`Enter`/`a` -> approve always, `Esc`/`n`/`Backspace` -> back to Stage 1, `Ctrl+C` -> plain decline.
 * - Stage 3 (`reject_steer`): printable chars edit `steeringInput`, `Backspace`/`Ctrl+U` delete, `Ctrl+C` clears non-empty input or returns to Stage 1, `Esc` -> back to Stage 1, `Enter` -> `rejected_with_steering` (if non-empty) or plain `declined` (if empty).
 */
export function reduceApprovalStageKey(
  state: ApprovalStageState,
  str: string | undefined,
  key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
): ApprovalStageStepResult {
  const name = key?.name?.toLowerCase();
  const ch = (str ?? "").toLowerCase();

  if (state.stage === "permission") {
    if (key?.ctrl && name === "c") {
      return { done: true, state, resolution: { kind: "declined" } };
    }
    if (name === "escape") {
      return { done: true, state, resolution: { kind: "declined" } };
    }
    if (key?.ctrl || key?.meta) return { done: false, state };
    if (ch === "y") {
      return { done: true, state, resolution: { kind: "approved", scope: "once" } };
    }
    if (ch === "a") {
      if (!state.canAlways) return { done: false, state };
      return { done: false, state: { ...state, stage: "always_confirm" } };
    }
    if (ch === "n" || ch === "r") {
      return { done: false, state: { ...state, stage: "reject_steer", steeringInput: "" } };
    }
    return { done: false, state };
  }

  if (state.stage === "always_confirm") {
    if (key?.ctrl && name === "c") {
      return { done: true, state, resolution: { kind: "declined" } };
    }
    if (name === "escape" || name === "backspace" || (!key?.ctrl && !key?.meta && ch === "n")) {
      return { done: false, state: { ...state, stage: "permission" } };
    }
    if (name === "return" || name === "enter" || (!key?.ctrl && !key?.meta && ch === "y")) {
      return { done: true, state, resolution: { kind: "approved", scope: "always" } };
    }
    return { done: false, state };
  }

  // Stage 3: reject_steer
  if (key?.ctrl && name === "c") {
    if (state.steeringInput.length > 0) {
      return { done: false, state: { ...state, steeringInput: "" } };
    }
    return { done: false, state: { ...state, stage: "permission", steeringInput: "" } };
  }
  if (key?.ctrl && name === "u") {
    return { done: false, state: { ...state, steeringInput: "" } };
  }
  if (name === "escape") {
    return { done: false, state: { ...state, stage: "permission", steeringInput: "" } };
  }
  if (name === "return" || name === "enter") {
    const feedback = state.steeringInput.trim();
    if (feedback.length > 0) {
      return { done: true, state, resolution: { kind: "rejected_with_steering", feedback } };
    }
    return { done: true, state, resolution: { kind: "declined" } };
  }
  if (name === "backspace") {
    if (state.steeringInput.length === 0) return { done: false, state };
    const chars = Array.from(state.steeringInput);
    chars.pop();
    return { done: false, state: { ...state, steeringInput: chars.join("") } };
  }
  if (!key?.ctrl && !key?.meta && typeof str === "string" && str.length > 0) {
    // Filter out control characters (C0/DEL/C1) while preserving normal Unicode text.
    const clean = str.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    if (clean.length > 0) {
      return { done: false, state: { ...state, steeringInput: state.steeringInput + clean } };
    }
  }
  return { done: false, state };
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

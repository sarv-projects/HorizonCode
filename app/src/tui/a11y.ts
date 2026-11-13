/**
 * a11y.ts — reduced-motion and screen-reader stubs (docs/13 D11).
 */

import type { StatusInfo } from "./live";
import { formatDuration, formatTokenHint } from "./live";
import type { UnknownEffectPayload } from "./unknown-chip";

export function reduceMotion(env: Record<string, string | undefined> = process.env): boolean {
  if (env.HZ_REDUCE_MOTION === "1" || env.HZ_REDUCE_MOTION === "true") return true;
  return false;
}

/** Spinner interval when animations are reduced (docs/13 D11). */
export function spinnerIntervalMs(env: Record<string, string | undefined> = process.env): number {
  return reduceMotion(env) ? 1000 : 100;
}

/** Plain status path for assistive tech or tests (docs/13 D11 reduced). */
export function screenReaderMode(env: Record<string, string | undefined> = process.env): boolean {
  if (env.HZ_SCREEN_READER === "1" || env.HZ_SCREEN_READER === "true") return true;
  if (env.HZ_A11Y_PLAIN === "1" || env.HZ_A11Y_PLAIN === "true") return true;
  return false;
}

/** Idle status as one spoken line (no glyphs or colour). */
export function formatIdleStatusAnnouncement(info: StatusInfo): string {
  const bits: string[] = [];
  if (info.badge) bits.push(`mode ${info.badge}`);
  if (info.model) bits.push(`model ${info.model}`);
  if (info.provider) bits.push(`provider ${info.provider}`);
  const tok = formatTokenHint(info.contextUsed, info.contextWindow);
  if (tok) bits.push(`context ${tok.replace(/\s+high$/, ", context high")}`);
  if (info.unknownCount && info.unknownCount > 0) {
    bits.push(`${info.unknownCount} unreconciled effect${info.unknownCount === 1 ? "" : "s"}`);
  }
  return bits.length > 0 ? `Status: ${bits.join("; ")}.` : "Status: ready.";
}

/** Busy footer without braille or pulse (docs/13 D11). */
export function formatBusyStatusAnnouncement(input: {
  verb?: string;
  more?: number;
  turnMs: number;
  esc?: boolean;
}): string {
  const verb = input.verb && input.verb !== "" ? input.verb.replace(/\u2026$/, "") : "Thinking";
  const extra =
    input.more && input.more > 0 ? ` and ${input.more} more tool${input.more === 1 ? "" : "s"}` : "";
  const cancel = input.esc ? "Press Escape to cancel." : "Press Control+C to cancel.";
  return `Working: ${verb}${extra}; elapsed ${formatDuration(input.turnMs)}. ${cancel}`;
}

/** Plain line when `hz.effect.unknown` is observed (docs/13 D11). */
export function formatUnknownEffectAnnouncement(payload: UnknownEffectPayload): string {
  const bits = ["Effect outcome could not be verified."];
  if (payload.tool !== undefined && payload.tool !== "") bits.push(`Tool ${payload.tool}.`);
  if (payload.receiptId !== undefined && payload.receiptId !== "") bits.push(`Receipt ${payload.receiptId}.`);
  bits.push(`Effect id ${payload.effectId.slice(0, 8)}.`);
  return bits.join(" ");
}

/** Plain line when a guard approval question opens (docs/13 D11). */
export function formatApprovalAskAnnouncement(input: {
  title: string;
  detail?: string;
  canAlways?: boolean;
}): string {
  const title = input.title.trim() || "this action";
  const detail = typeof input.detail === "string" && input.detail.trim() !== "" ? ` ${input.detail.trim()}.` : "";
  const keys = input.canAlways
    ? "Press y for yes, n for no, a for always this session, Escape to deny."
    : "Press y for yes, n for no, Escape to deny.";
  return `Approval required: ${title}.${detail} ${keys}`;
}

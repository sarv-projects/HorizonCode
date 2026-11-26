/**
 * tool-call-id.ts -- descriptor-driven tool-call id normalization (plan Task 7).
 *
 * Pure opt-in seam. The caller supplies a data rule (vendor, length, allowed
 * characters, prefix); no provider/model-id string matching occurs here.
 * Existing adapter quirks stay byte-identical.
 */

import { sha256Hex } from "../canon";
import type { ProviderEvent } from "../../contracts";

export interface ToolIdRule {
  vendor: string;
  maxLength: number;
  allowed: RegExp;
  prefix: string;
}

export interface NormalizedToolId {
  id: string;
  changed: boolean;
  /** Present when no usable id could be produced; never a generated random id. */
  refusal?: string;
}

export function normalizeToolCallId(raw: string, rule: ToolIdRule): NormalizedToolId {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { id: "", changed: false, refusal: "tool id is empty" };
  }
  const cleaned = Array.from(raw).filter((char) => rule.allowed.test(char)).join("");
  if (cleaned === "") {
    return { id: "", changed: false, refusal: "tool id has no allowed characters" };
  }
  const body = cleaned.startsWith(rule.prefix) ? cleaned.slice(rule.prefix.length) : cleaned;
  if (body === "") {
    return { id: "", changed: false, refusal: "tool id has no body after prefix" };
  }
  let id = `${rule.prefix}${body}`;
  if (id.length > rule.maxLength) {
    const suffix = sha256Hex(raw).slice(0, 8);
    const keep = Math.max(1, rule.maxLength - rule.prefix.length - suffix.length);
    id = `${rule.prefix}${body.slice(0, keep)}${suffix}`.slice(0, rule.maxLength);
  }
  return { id, changed: id !== raw };
}

/**
 * V-15 wiring seam: normalize emitted tool-call ids to a data-supplied vendor
 * rule. Text/done events pass through byte-identically. An unusable id becomes
 * a notice (never a random id), so the call is not dispatched with an id the
 * provider would reject.
 */
export function normalizeToolCallEvents(
  events: readonly ProviderEvent[],
  rule: ToolIdRule,
): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") {
      out.push(event);
      continue;
    }
    const normalized = normalizeToolCallId(event.id, rule);
    if (normalized.refusal !== undefined || normalized.id === "") {
      out.push({
        type: "notice",
        message: `tool id refused: ${normalized.refusal ?? "empty"}`,
      });
      continue;
    }
    out.push({ ...event, id: normalized.id });
  }
  return out;
}

/** Stable replay map so a replayed tool result can reference its original id. */
export function toolIdReplayMap(rawIds: readonly string[], rule: ToolIdRule): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of rawIds) {
    const result = normalizeToolCallId(raw, rule);
    if (result.refusal === undefined) map.set(raw, result.id);
  }
  return map;
}

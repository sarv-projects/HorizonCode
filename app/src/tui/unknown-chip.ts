/**
 * unknown-chip.ts — reduced UNKNOWN status surfaces (docs/13 R169–R170; docs/28 ruling 235).
 *
 * Pure formatting + a tiny event counter for the status bar. Resource blocking
 * R170 same-path gate ships in `effect-resource-gate.ts` + `loop.ts` (**243**).
 * Reconcile-block latch chip: `reconcile-block-chip.ts` + status bar (**304** reduced).
 * Full inspector list: `/unknown` and status click (ruling **264**).
 */

import type { RuntimeEvent } from "../contracts";
import { bold, yellow } from "./style";

export interface UnknownEffectPayload {
  effectId: string;
  tool?: string;
  receiptId?: string;
  callId?: string;
}

/** Scrollback / notice line when `hz.effect.unknown` is observed. */
export function formatUnknownEffectNotice(payload: UnknownEffectPayload): string {
  const bits = ["effect outcome unverified (UNKNOWN)"];
  if (payload.tool !== undefined && payload.tool !== "") bits.push(`tool ${payload.tool}`);
  if (payload.receiptId !== undefined && payload.receiptId !== "") bits.push(`receipt ${payload.receiptId}`);
  bits.push(`effect ${payload.effectId.slice(0, 8)}`);
  return bits.join(" · ");
}

/** Status-bar chip segment (distinct from error styling). */
export function formatUnknownStatusChip(count: number, latestReceiptId?: string): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count === 1 && latestReceiptId !== undefined && latestReceiptId !== "") {
    const short = latestReceiptId.length > 12 ? `${latestReceiptId.slice(0, 8)}…` : latestReceiptId;
    return bold(yellow(`UNKNOWN · ${short}`));
  }
  return bold(yellow(count === 1 ? "UNKNOWN 1" : `UNKNOWN ${count}`));
}

/** Plain-text suffix for fullscreen experimental status row. */
export function fullscreenUnknownExtra(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count === 1 ? "UNKNOWN 1" : `UNKNOWN ${count}`;
}

/** Apply additive `effect.*` facade events to an unreconciled count. */
export function unknownCountAfterEvent(count: number, ev: RuntimeEvent): number {
  if (!ev || typeof ev !== "object") return count;
  if (ev.type === "effect.unknown") return count + 1;
  if (ev.type === "effect.reconciled") return Math.max(0, count - 1);
  return count;
}

/**
 * reconcile-block-chip.ts — R170 reduced reconcile-block status surfaces (ruling **304**).
 */

import type { EffectReconcileBlockLatchView } from "../core/effect-reconcile-block";
import {
  formatObservePendingInspectorLines,
  formatReconcileBlockListLines,
} from "../core/effect-reconcile-block";
import { bold, red, yellow } from "./style";

/** Status-bar chip when mutating tools are blocked pending reconcile or observe (**342**). */
export function formatReconcileBlockStatusChip(view: EffectReconcileBlockLatchView): string {
  if (view.mode === "off") return "";
  const parts: string[] = [];
  if (view.latched) {
    parts.push(view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate");
  }
  if (view.observePendingActive) {
    parts.push("BLOCK observe");
  }
  if (parts.length === 0) return "";
  return bold(red(parts.join(" · ")));
}

/** Plain-text suffix for fullscreen experimental status row. */
export function fullscreenReconcileBlockExtra(view: EffectReconcileBlockLatchView): string {
  if (view.mode === "off") return "";
  const parts: string[] = [];
  if (view.latched) {
    parts.push(view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate");
  }
  if (view.observePendingActive) parts.push("BLOCK observe");
  return parts.join(" · ");
}

/** Scrollback notice when the reconcile block latch engages. */
export function formatReconcileBlockBarrierNotice(view: EffectReconcileBlockLatchView): string {
  if (!view.latched) return "";
  const scope = view.mode === "resource" ? "path-filtered" : "session-wide";
  return `mutating tools blocked (${scope}) until /unknown reconcile — ${view.reason ?? "reconcile pending"}`;
}

/** Scrollback transcript lines when latch engages or blocked paths change (ruling **310**, **342**). */
export function formatReconcileBlockScrollbackNoticeLines(view: EffectReconcileBlockLatchView): string[] {
  if (view.mode === "off") return [];
  const lines: string[] = [];
  if (view.latched) {
    const modeLabel = view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate";
    lines.push(formatReconcileBlockBarrierNotice(view), `status bar: ${modeLabel}`);
    for (const extra of formatReconcileBlockListLines(view)) {
      if (extra.trim() !== "") lines.push(extra);
    }
  } else if (view.observePendingActive) {
    for (const line of formatObservePendingInspectorLines(view)) {
      lines.push(line);
    }
    lines.push("status bar: BLOCK observe");
  }
  return lines;
}

/** Stable key for deduping scrollback reconcile-block notices across idle refreshes. */
export function reconcileBlockScrollbackNoticeKey(view: EffectReconcileBlockLatchView): string {
  if (view.mode === "off") return "";
  const paths = view.blockedPaths ?? [];
  const pending =
    view.observePendingDependencies?.map((d) => `${d.resourcePath}\0${d.effectIds.join(",")}`).join("\0") ?? "";
  const latchBit = view.latched ? "1" : "0";
  return `${latchBit}\0${view.mode}\0${view.reason ?? ""}\0${paths.join("\0")}\0${pending}`;
}

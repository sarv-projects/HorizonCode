/**
 * reconcile-block-chip.ts — R170 reduced reconcile-block status surfaces (ruling **304**).
 */

import type { EffectReconcileBlockLatchView } from "../core/effect-reconcile-block";
import { formatReconcileBlockListLines } from "../core/effect-reconcile-block";
import { bold, red, yellow } from "./style";

/** Status-bar chip when mutating tools are blocked pending reconcile. */
export function formatReconcileBlockStatusChip(view: EffectReconcileBlockLatchView): string {
  if (!view.latched || view.mode === "off") return "";
  const label = view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate";
  return bold(red(label));
}

/** Plain-text suffix for fullscreen experimental status row. */
export function fullscreenReconcileBlockExtra(view: EffectReconcileBlockLatchView): string {
  if (!view.latched || view.mode === "off") return "";
  return view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate";
}

/** Scrollback notice when the reconcile block latch engages. */
export function formatReconcileBlockBarrierNotice(view: EffectReconcileBlockLatchView): string {
  if (!view.latched) return "";
  const scope = view.mode === "resource" ? "path-filtered" : "session-wide";
  return `mutating tools blocked (${scope}) until /unknown reconcile — ${view.reason ?? "reconcile pending"}`;
}

/** Scrollback transcript lines when latch engages or blocked paths change (ruling **310**). */
export function formatReconcileBlockScrollbackNoticeLines(view: EffectReconcileBlockLatchView): string[] {
  if (!view.latched || view.mode === "off") return [];
  const modeLabel = view.mode === "resource" ? "BLOCK resource" : "BLOCK mutate";
  const lines = [formatReconcileBlockBarrierNotice(view), `status bar: ${modeLabel}`];
  for (const extra of formatReconcileBlockListLines(view)) {
    if (extra.trim() !== "") lines.push(extra);
  }
  return lines;
}

/** Stable key for deduping scrollback reconcile-block notices across idle refreshes. */
export function reconcileBlockScrollbackNoticeKey(view: EffectReconcileBlockLatchView): string {
  if (!view.latched || view.mode === "off") return "";
  const paths = view.blockedPaths ?? [];
  return `${view.mode}\0${view.reason ?? ""}\0${paths.join("\0")}`;
}

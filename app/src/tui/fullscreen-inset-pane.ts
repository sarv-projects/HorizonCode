/**
 * fullscreen-inset-pane.ts — live inset scrollback content for alt-screen chat (ruling 300).
 */

import type { EffectReconcileBlockLatchView } from "../core/effect-reconcile-block";
import {
  formatEffectReconcileBlockStatusLines,
  formatObservePendingInspectorLines,
  formatReconcileBlockListLines,
} from "../core/effect-reconcile-block";
import type { UnknownEffectRow } from "../core/effect-unknown-list";
import { formatUnknownInspectorLines } from "./unknown-inspector";
import { fullscreenLayoutWithInsetPane } from "./fullscreen-layout";
import { fullscreenReconcileBlockExtra } from "./reconcile-block-chip";

/** Default inset height when toggled on (capped by layout). */
export const FULLSCREEN_INSET_PANE_ROWS = 4;

export function fullscreenInsetPaneRowCount(totalHeight: number): number {
  return fullscreenLayoutWithInsetPane(totalHeight, FULLSCREEN_INSET_PANE_ROWS).insetPaneRows;
}

/** Inset scrollback body when reconcile-block is latched (ruling **309**). */
export function buildInsetReconcileBlockLogicalLines(
  view: EffectReconcileBlockLatchView | undefined,
): string[] {
  if (!view?.latched || view.mode === "off") return [];
  const banner = fullscreenReconcileBlockExtra(view);
  if (!banner) return [];
  return [
    `— inset ${banner} —`,
    ...formatEffectReconcileBlockStatusLines(view),
    ...formatReconcileBlockListLines(view),
  ];
}

/** Inset scrollback when observe-pending overlap gate is active without reconcile latch (**342**). */
export function buildInsetObservePendingLogicalLines(
  view: EffectReconcileBlockLatchView | undefined,
): string[] {
  if (!view?.observePendingActive || view.mode === "off" || view.latched) return [];
  const banner = fullscreenReconcileBlockExtra(view);
  if (!banner) return [];
  return [`— inset ${banner} —`, ...formatObservePendingInspectorLines(view)];
}

/**
 * Full logical inset scrollback (viewport applied at paint via `insetScrollBack`).
 * Reconcile-block banner when latched; else UNKNOWN summary; else buried transcript.
 */
export function buildFullscreenInsetLogicalLines(opts: {
  transcript: readonly string[];
  mainScrollUp: number;
  unknownRows: readonly UnknownEffectRow[];
  reconcileBlock?: EffectReconcileBlockLatchView;
}): string[] {
  const { transcript, mainScrollUp, unknownRows, reconcileBlock } = opts;
  const blockLines = buildInsetReconcileBlockLogicalLines(reconcileBlock);
  if (blockLines.length > 0) return blockLines;
  const observeLines = buildInsetObservePendingLogicalLines(reconcileBlock);
  if (observeLines.length > 0) return observeLines;
  if (unknownRows.length > 0) {
    return formatUnknownInspectorLines(unknownRows);
  }
  if (mainScrollUp <= 0) {
    return [
      "— inset scrollback (Ctrl+B) · wheel or Alt+↑/↓ / PgUp/PgDn on inset; wheel on main scrolls transcript —",
    ];
  }
  const end = Math.max(0, transcript.length - mainScrollUp);
  if (end === 0) return ["— inset empty —"];
  const buried = transcript.slice(0, end);
  return ["— buried transcript —", ...buried];
}

/** @deprecated Use `buildFullscreenInsetLogicalLines`; paint applies viewport scroll. */
export function buildFullscreenInsetScrollbackLines(opts: {
  transcript: readonly string[];
  scrollUp: number;
  unknownRows: readonly UnknownEffectRow[];
}): string[] {
  return buildFullscreenInsetLogicalLines({
    transcript: opts.transcript,
    mainScrollUp: opts.scrollUp,
    unknownRows: opts.unknownRows,
  });
}

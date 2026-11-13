/**
 * hit-test.ts — cached layout rects for fullscreen mouse (docs/13 D3 step 2).
 *
 * Pure geometry only: callers bump `layoutVersion` on resize and rebuild rects
 * each paint. Mouse events use 1-based row/col (DEC/xterm convention).
 */

import {
  fullscreenLayoutRows,
  fullscreenLayoutWithInsetPane,
  type FullscreenInsetPaneLayout,
} from "./fullscreen-layout";

export type HitRegionId = "status" | "transcript" | "input" | "scrollback_pane" | "completion_overlay";

export type HitAction = "noop" | "scroll" | "focus_input";

export interface HitRect {
  region: HitRegionId;
  /** 0-based column */
  x: number;
  /** 0-based row */
  y: number;
  w: number;
  h: number;
  layoutVersion: number;
  action: HitAction;
}

export interface HitTestCache {
  layoutVersion: number;
  rects: HitRect[];
}

export interface FullscreenHitRectOptions {
  /** When >0, bottom transcript rows become a distinct scrollback pane target (ruling 284). */
  insetPaneRows?: number;
  /** Grok R6/R11 reduced: full-frame hit target while a modal overlay owns the loop. */
  modalOverlay?: "completion";
}

export type FullscreenModalOverlayFlags = {
  picker?: boolean;
  palette?: boolean;
  inspector?: boolean;
  completion?: boolean;
};

/** Hit-test opts while picker/palette/inspector/completion overlays own input (ruling **312**). */
export function fullscreenModalOverlayHitOpts(
  flags: FullscreenModalOverlayFlags,
): Pick<FullscreenHitRectOptions, "modalOverlay"> {
  if (flags.picker || flags.palette || flags.inspector || flags.completion) {
    return { modalOverlay: "completion" };
  }
  return {};
}

/** Fullscreen reduced layout: one row each for status and input, middle transcript. */
export function buildFullscreenHitRects(
  width: number,
  height: number,
  layoutVersion: number,
  opts: FullscreenHitRectOptions = {},
): HitRect[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(3, Math.floor(height));
  const paneRows = Math.max(0, Math.floor(opts.insetPaneRows ?? 0));
  const layout = paneRows > 0 ? fullscreenLayoutWithInsetPane(h, paneRows) : fullscreenLayoutRows(h);
  const rects: HitRect[] = [
    { region: "status", x: 0, y: layout.statusRow, w, h: 1, layoutVersion, action: "noop" },
  ];
  if (paneRows > 0 && "insetPaneStart" in layout) {
    const inset = layout as FullscreenInsetPaneLayout;
    rects.push({
      region: "transcript",
      x: 0,
      y: layout.transcriptStart,
      w,
      h: inset.mainTranscriptRows,
      layoutVersion,
      action: "scroll",
    });
    rects.push({
      region: "scrollback_pane",
      x: 0,
      y: inset.insetPaneStart,
      w,
      h: inset.insetPaneRows,
      layoutVersion,
      action: "scroll",
    });
  } else {
    rects.push({
      region: "transcript",
      x: 0,
      y: layout.transcriptStart,
      w,
      h: layout.transcriptRows,
      layoutVersion,
      action: "scroll",
    });
  }
  rects.push({ region: "input", x: 0, y: layout.inputRow, w, h: 1, layoutVersion, action: "focus_input" });
  if (opts.modalOverlay === "completion") {
    rects.unshift({
      region: "completion_overlay",
      x: 0,
      y: 0,
      w,
      h,
      layoutVersion,
      action: "noop",
    });
  }
  return rects;
}

/** Grok R11 reduced: resize bumps layout version so prior hit rects fail `hitTestAt`. */
export function hitTestCacheAfterResize(
  width: number,
  height: number,
  prev: HitTestCache,
  opts: FullscreenHitRectOptions = {},
): HitTestCache {
  return createHitTestCache(width, height, prev.layoutVersion + 1, opts);
}

export function createHitTestCache(
  width: number,
  height: number,
  layoutVersion: number,
  opts: FullscreenHitRectOptions = {},
): HitTestCache {
  return { layoutVersion, rects: buildFullscreenHitRects(width, height, layoutVersion, opts) };
}

/** Returns the topmost matching rect, or undefined when outside the frame. */
export function hitTestAt(col: number, row: number, cache: HitTestCache): HitRect | undefined {
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1) return undefined;
  const c0 = Math.floor(col) - 1;
  const r0 = Math.floor(row) - 1;
  for (const rect of cache.rects) {
    if (rect.layoutVersion !== cache.layoutVersion) continue;
    if (c0 >= rect.x && c0 < rect.x + rect.w && r0 >= rect.y && r0 < rect.y + rect.h) return rect;
  }
  return undefined;
}

export function hitRectStale(rect: HitRect, layoutVersion: number): boolean {
  return rect.layoutVersion !== layoutVersion;
}

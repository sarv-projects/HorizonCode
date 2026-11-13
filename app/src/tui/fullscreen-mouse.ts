/**
 * fullscreen-mouse.ts — apply parsed mouse events to fullscreen chat state
 * (docs/13 D3 reduced; HZ_TUI_MOUSE=1).
 */

import type { MouseEvent } from "./mouse-parse";
import { hitTestAt, type HitTestCache } from "./hit-test";

export interface FullscreenMouseState {
  /** Lines scrolled up from the bottom of the transcript buffer (0 = pinned). */
  scrollUp: number;
  /** Wrapped lines scrolled up within the inset scrollback pane. */
  insetScrollUp: number;
  hitCache: HitTestCache;
  maxScroll: number;
  maxInsetScroll: number;
}

export type FullscreenMouseEffect =
  | { kind: "noop" }
  | { kind: "scroll_main"; scrollUp: number }
  | { kind: "scroll_inset"; insetScrollUp: number }
  | { kind: "focus_input" }
  | { kind: "show_unknown" }
  | { kind: "dismiss_modal_overlay" };

export interface FullscreenMouseInspectOptions {
  /** When true, a primary click on the status row opens the UNKNOWN inspector. */
  statusShowsUnknown?: boolean;
  /** Grok R26 reduced: primary click on modal backdrop dismisses the overlay (ruling **313**). */
  modalOverlayActive?: boolean;
}

/** Wheel / click mapping over the reduced status|transcript|input layout. */
export function applyFullscreenMouseEvent(
  ev: MouseEvent,
  state: FullscreenMouseState,
  opts: FullscreenMouseInspectOptions = {},
): FullscreenMouseEffect {
  const hit = hitTestAt(ev.col, ev.row, state.hitCache);
  if (!hit) return { kind: "noop" };

  if (ev.action === "wheel") {
    const delta = ev.button === 0 ? 1 : ev.button === 1 ? -1 : 0;
    if (delta === 0) return { kind: "noop" };
    if (hit.region === "transcript") {
      const next = Math.max(0, Math.min(state.maxScroll, state.scrollUp + delta));
      if (next === state.scrollUp) return { kind: "noop" };
      return { kind: "scroll_main", scrollUp: next };
    }
    if (hit.region === "scrollback_pane") {
      const next = Math.max(0, Math.min(state.maxInsetScroll, state.insetScrollUp + delta));
      if (next === state.insetScrollUp) return { kind: "noop" };
      return { kind: "scroll_inset", insetScrollUp: next };
    }
    return { kind: "noop" };
  }

  if (ev.action === "press" && hit.action === "focus_input") {
    return { kind: "focus_input" };
  }

  if (
    opts.modalOverlayActive === true &&
    ev.action === "press" &&
    ev.button === 0 &&
    hit.region === "completion_overlay"
  ) {
    return { kind: "dismiss_modal_overlay" };
  }

  if (
    opts.statusShowsUnknown === true &&
    ev.action === "press" &&
    ev.button === 0 &&
    hit.region === "status"
  ) {
    return { kind: "show_unknown" };
  }

  return { kind: "noop" };
}

import { describe, expect, test } from "bun:test";
import { createHitTestCache } from "../../src/tui/hit-test";
import { applyFullscreenMouseEvent } from "../../src/tui/fullscreen-mouse";
import type { MouseEvent } from "../../src/tui/mouse-parse";

function wheel(row: number, col: number, button: 0 | 1): MouseEvent {
  return {
    encoding: "sgr",
    action: "wheel",
    button,
    row,
    col,
    shift: false,
    meta: false,
    ctrl: false,
  };
}

describe("fullscreen-mouse", () => {
  test("wheel over transcript scrolls main within max", () => {
    const hitCache = createHitTestCache(80, 24, 1);
    const state = { scrollUp: 0, insetScrollUp: 0, hitCache, maxScroll: 5, maxInsetScroll: 0 };
    const up = applyFullscreenMouseEvent(wheel(12, 40, 0), state);
    expect(up).toEqual({ kind: "scroll_main", scrollUp: 1 });
    const down = applyFullscreenMouseEvent(wheel(12, 40, 1), { ...state, scrollUp: 1 });
    expect(down).toEqual({ kind: "scroll_main", scrollUp: 0 });
  });

  test("wheel over inset pane scrolls inset independently", () => {
    const hitCache = createHitTestCache(80, 24, 1, { insetPaneRows: 4 });
    const paneRow = hitCache.rects.find((r) => r.region === "scrollback_pane")!.y + 1;
    const state = { scrollUp: 3, insetScrollUp: 0, hitCache, maxScroll: 10, maxInsetScroll: 6 };
    const up = applyFullscreenMouseEvent(wheel(paneRow, 40, 0), state);
    expect(up).toEqual({ kind: "scroll_inset", insetScrollUp: 1 });
    const main = applyFullscreenMouseEvent(wheel(10, 40, 0), state);
    expect(main).toEqual({ kind: "scroll_main", scrollUp: 4 });
  });

  test("status click opens UNKNOWN inspector when enabled", () => {
    const hitCache = createHitTestCache(80, 24, 1);
    const effect = applyFullscreenMouseEvent(
      {
        encoding: "sgr",
        action: "press",
        button: 0,
        row: 1,
        col: 5,
        shift: false,
        meta: false,
        ctrl: false,
      },
      { scrollUp: 0, insetScrollUp: 0, hitCache, maxScroll: 0, maxInsetScroll: 0 },
      { statusShowsUnknown: true },
    );
    expect(effect).toEqual({ kind: "show_unknown" });
  });

  test("completion overlay hit region blocks wheel scroll (Grok R6 reduced)", () => {
    const hitCache = createHitTestCache(80, 24, 1, { modalOverlay: "completion" });
    const state = { scrollUp: 0, insetScrollUp: 0, hitCache, maxScroll: 5, maxInsetScroll: 0 };
    expect(applyFullscreenMouseEvent(wheel(12, 40, 0), state)).toEqual({ kind: "noop" });
  });

  test("modal overlay primary click dismisses (Grok R26 reduced, ruling 313)", () => {
    const hitCache = createHitTestCache(80, 24, 1, { modalOverlay: "completion" });
    const state = { scrollUp: 0, insetScrollUp: 0, hitCache, maxScroll: 5, maxInsetScroll: 0 };
    const effect = applyFullscreenMouseEvent(
      {
        encoding: "sgr",
        action: "press",
        button: 0,
        row: 12,
        col: 40,
        shift: false,
        meta: false,
        ctrl: false,
      },
      state,
      { modalOverlayActive: true },
    );
    expect(effect).toEqual({ kind: "dismiss_modal_overlay" });
  });

  test("press on input focuses", () => {
    const hitCache = createHitTestCache(80, 24, 1);
    const effect = applyFullscreenMouseEvent(
      {
        encoding: "sgr",
        action: "press",
        button: 0,
        row: 24,
        col: 2,
        shift: false,
        meta: false,
        ctrl: false,
      },
      { scrollUp: 0, insetScrollUp: 0, hitCache, maxScroll: 0, maxInsetScroll: 0 },
    );
    expect(effect).toEqual({ kind: "focus_input" });
  });
});

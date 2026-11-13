import { describe, expect, test } from "bun:test";
import {
  buildFullscreenHitRects,
  createHitTestCache,
  fullscreenModalOverlayHitOpts,
  hitRectStale,
  hitTestAt,
  hitTestCacheAfterResize,
} from "../../src/tui/hit-test";

describe("hit-test fullscreen rects", () => {
  test("status / transcript / input cover the frame", () => {
    const rects = buildFullscreenHitRects(80, 24, 1);
    expect(rects.map((r) => r.region)).toEqual(["status", "transcript", "input"]);
    const cache = createHitTestCache(80, 24, 1);
    expect(hitTestAt(1, 1, cache)?.region).toBe("status");
    expect(hitTestAt(40, 12, cache)?.region).toBe("transcript");
    expect(hitTestAt(1, 24, cache)?.region).toBe("input");
    expect(hitTestAt(0, 1, cache)).toBeUndefined();
  });

  test("inset scrollback pane region when configured", () => {
    const rects = buildFullscreenHitRects(80, 24, 1, { insetPaneRows: 4 });
    expect(rects.map((r) => r.region)).toEqual(["status", "transcript", "scrollback_pane", "input"]);
    const cache = createHitTestCache(80, 24, 1, { insetPaneRows: 4 });
    const paneRow = cache.rects.find((r) => r.region === "scrollback_pane")!.y + 1;
    expect(hitTestAt(10, paneRow, cache)?.region).toBe("scrollback_pane");
  });

  test("stale layoutVersion misses", () => {
    const cache = createHitTestCache(40, 10, 2);
    const rect = cache.rects[0]!;
    expect(hitRectStale(rect, 3)).toBe(true);
    expect(hitTestAt(1, 1, { layoutVersion: 3, rects: cache.rects })).toBeUndefined();
  });

  test("R11 reduced: resize rebuilds cache and bumps layout version", () => {
    const before = createHitTestCache(80, 24, 4);
    expect(hitTestAt(40, 12, before)?.region).toBe("transcript");
    const after = hitTestCacheAfterResize(100, 30, before);
    expect(after.layoutVersion).toBe(5);
    expect(hitTestAt(40, 12, { layoutVersion: 4, rects: after.rects })).toBeUndefined();
    expect(hitTestAt(50, 15, after)?.region).toBe("transcript");
  });

  test("completion modal overlay covers frame (Grok R6 reduced)", () => {
    const cache = createHitTestCache(80, 24, 1, { modalOverlay: "completion" });
    expect(hitTestAt(40, 12, cache)?.region).toBe("completion_overlay");
    expect(hitTestAt(1, 24, cache)?.region).toBe("completion_overlay");
  });

  test("modal overlay hit opts when any overlay flag (ruling 312)", () => {
    expect(fullscreenModalOverlayHitOpts({})).toEqual({});
    expect(fullscreenModalOverlayHitOpts({ picker: true })).toEqual({ modalOverlay: "completion" });
    expect(fullscreenModalOverlayHitOpts({ palette: true })).toEqual({ modalOverlay: "completion" });
    expect(fullscreenModalOverlayHitOpts({ inspector: true })).toEqual({ modalOverlay: "completion" });
    expect(fullscreenModalOverlayHitOpts({ completion: true })).toEqual({ modalOverlay: "completion" });
  });
});

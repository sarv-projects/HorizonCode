import { describe, expect, test } from "bun:test";
import { applyFullscreenInsetKey } from "../../src/tui/fullscreen-inset-keys";
import type * as readline from "node:readline";

function key(name: string, opts: Partial<readline.Key> = {}): readline.Key {
  return { name, ...opts };
}

describe("fullscreen-inset-keys", () => {
  const base = { insetOpen: true, insetScrollUp: 2, maxInsetScroll: 10, insetPaneRows: 4 };

  test("Alt+Up/Down nudge inset scroll", () => {
    expect(applyFullscreenInsetKey(key("up", { meta: true }), base)).toEqual({
      kind: "scroll_inset",
      insetScrollUp: 3,
    });
    expect(applyFullscreenInsetKey(key("down", { meta: true }), base)).toEqual({
      kind: "scroll_inset",
      insetScrollUp: 1,
    });
  });

  test("PgUp/PgDn page within inset when open", () => {
    expect(applyFullscreenInsetKey(key("pageup"), base)).toEqual({
      kind: "scroll_inset",
      insetScrollUp: 6,
    });
    expect(applyFullscreenInsetKey(key("pagedown"), { ...base, insetScrollUp: 6 })).toEqual({
      kind: "scroll_inset",
      insetScrollUp: 2,
    });
  });

  test("noop when inset closed or at bound", () => {
    expect(applyFullscreenInsetKey(key("pageup"), { ...base, insetOpen: false })).toEqual({ kind: "noop" });
    expect(applyFullscreenInsetKey(key("down", { meta: true }), { ...base, insetScrollUp: 0 })).toEqual({
      kind: "noop",
    });
    expect(applyFullscreenInsetKey(key("up", { meta: true }), { ...base, insetScrollUp: 10 })).toEqual({
      kind: "noop",
    });
  });
});

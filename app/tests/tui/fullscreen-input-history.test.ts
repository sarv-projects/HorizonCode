import { describe, expect, test } from "bun:test";
import {
  createFullscreenInputHistory,
  historyNavigateDown,
  historyNavigateUp,
  pushFullscreenHistoryEntry,
} from "../../src/tui/fullscreen-input-history";

describe("fullscreen-input-history", () => {
  test("up and down recall prior lines", () => {
    let state = createFullscreenInputHistory(["first", "second"]);
    const up1 = historyNavigateUp(state, "draft");
    expect(up1.text).toBe("second");
    state = up1.state;
    const up2 = historyNavigateUp(state, up1.text);
    expect(up2.text).toBe("first");
    state = up2.state;
    const down = historyNavigateDown(state, up2.text);
    expect(down.text).toBe("second");
    const bottom = historyNavigateDown(down.state, down.text);
    expect(bottom.text).toBe("draft");
    expect(bottom.state.index).toBe(-1);
  });

  test("push dedupes consecutive entries", () => {
    let state = createFullscreenInputHistory([]);
    state = pushFullscreenHistoryEntry(state, "a");
    state = pushFullscreenHistoryEntry(state, "a");
    expect(state.entries).toEqual(["a"]);
    state = pushFullscreenHistoryEntry(state, "b");
    expect(state.entries).toEqual(["a", "b"]);
  });
});

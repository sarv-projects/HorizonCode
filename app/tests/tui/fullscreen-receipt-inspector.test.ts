import { describe, expect, test } from "bun:test";
import {
  applyReceiptInspectorKey,
  buildFullscreenReceiptInspectorFrame,
  initialReceiptInspectorState,
} from "../../src/tui/fullscreen-receipt-inspector";

describe("fullscreen receipt inspector overlay (ruling 284)", () => {
  test("scroll and dismiss", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    let state = initialReceiptInspectorState(lines);
    const step = applyReceiptInspectorKey(state, { kind: "down" }, 5);
    expect(step.outcome).toEqual({ kind: "pending" });
    expect(step.state.scrollOffset).toBe(1);
    const esc = applyReceiptInspectorKey(state, { kind: "dismiss" }, 5);
    expect(esc.outcome).toEqual({ kind: "dismiss" });
  });

  test("builds cell frame", () => {
    const state = initialReceiptInspectorState(["── Receipt summary ──", "  receiptId x"]);
    const buf = buildFullscreenReceiptInspectorFrame({ width: 40, height: 8, state });
    expect(buf.width).toBe(40);
    expect(buf.height).toBe(8);
  });
});

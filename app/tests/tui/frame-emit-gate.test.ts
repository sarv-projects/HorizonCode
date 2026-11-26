/**
 * frame-emit-gate.test.ts — TUI surface: zero-byte frame suppression +
 * cursor-blink-aware dedup (grok terminal writer ADAPT). Pure gate over frames.
 */
import { describe, expect, test } from "bun:test";
import { createFrameEmitGate } from "../../src/tui/frame-emit-gate";

describe("frame emit gate (zero-byte suppression)", () => {
  test("suppresses empty frames and unchanged frames; emits changed ones", () => {
    const g = createFrameEmitGate();
    expect(g.emit("")).toBe(false); // zero-byte suppressed
    expect(g.emit("frame A")).toBe(true);
    expect(g.emit("frame A")).toBe(false); // unchanged dedup
    expect(g.emit("frame B")).toBe(true);
    expect(g.lastEmitted).toBe("frame B");
    expect(g.emittedCount).toBe(2);
  });

  test("a forced emit (e.g. cursor blink tick) re-sends an unchanged frame", () => {
    const g = createFrameEmitGate();
    expect(g.emit("frame A")).toBe(true);
    expect(g.emit("frame A", { force: true })).toBe(true);
    expect(g.emittedCount).toBe(2);
  });

  test("reset clears the last frame so the next identical frame is emitted", () => {
    const g = createFrameEmitGate();
    g.emit("X");
    g.reset();
    expect(g.emit("X")).toBe(true);
  });

  test("suppressed frames do not advance the emitted counter", () => {
    const g = createFrameEmitGate();
    g.emit("A");
    g.emit(""); // suppressed
    g.emit("A"); // dedup
    expect(g.emittedCount).toBe(1);
  });
});

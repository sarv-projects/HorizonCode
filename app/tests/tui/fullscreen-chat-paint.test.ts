import { describe, expect, test } from "bun:test";
import {
  buildFullscreenFrame,
  encodeFullscreenConsecutiveFrameDiff,
  encodeFullscreenFrameDiff,
} from "../../src/tui/fullscreen-layout";
import {
  buildFullscreenPaletteFrame,
  fullscreenPaletteStateWithQuery,
} from "../../src/tui/fullscreen-palette";

/** Mirrors consecutive `fullscreen-chat.ts` `paint()` encodes (ruling **308**). */
function consecutivePaintStream(
  frames: Array<Parameters<typeof buildFullscreenFrame>[0]>,
): { first: string; second: string } {
  let prev = null as ReturnType<typeof buildFullscreenFrame> | null;
  let first = "";
  let second = "";
  for (let i = 0; i < frames.length; i += 1) {
    const frame = buildFullscreenFrame(frames[i]!);
    const encoded = encodeFullscreenFrameDiff(prev, frame);
    if (i === 0) first = encoded;
    if (i === 1) second = encoded;
    prev = frame;
  }
  return { first, second };
}

describe("fullscreen-chat differential paint (ruling 308)", () => {
  const base = {
    width: 40,
    height: 8,
    status: "idle",
    transcript: ["hello"],
    input: "",
  };

  test("consecutive frames use differential encoding without full clear", () => {
    const { first, second } = consecutivePaintStream([
      base,
      { ...base, input: "x" },
    ]);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).toContain("\u001b[2J");
    expect(second).not.toContain("\u001b[2J");
    expect(second).toContain("x");
  });

  test("dimension change triggers full repaint on second frame", () => {
    const frameA = buildFullscreenFrame(base);
    const frameB = buildFullscreenFrame({ ...base, height: 10 });
    const diff = encodeFullscreenFrameDiff(frameA, frameB);
    expect(diff).toContain("\u001b[2J");
  });
});

describe("fullscreen overlay differential paint (ruling 310)", () => {
  test("consecutive palette frames diff without full clear", () => {
    const custom: string[] = [];
    const stateA = fullscreenPaletteStateWithQuery(custom, "th");
    const stateB = fullscreenPaletteStateWithQuery(custom, "the");
    const frameA = buildFullscreenPaletteFrame({ width: 50, height: 10, state: stateA });
    const frameB = buildFullscreenPaletteFrame({ width: 50, height: 10, state: stateB });
    const first = encodeFullscreenConsecutiveFrameDiff(null, frameA, null, "palette");
    const second = encodeFullscreenConsecutiveFrameDiff(frameA, frameB, "palette", "palette");
    expect(first).toContain("\u001b[2J");
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toContain("\u001b[2J");
  });
});

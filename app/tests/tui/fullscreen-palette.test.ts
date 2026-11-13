import { describe, expect, test } from "bun:test";
import { encodeDiffRuns, diffBuffers } from "../../src/tui/cellbuffer";
import { rankPaletteCommands } from "../../src/tui/command-palette";
import {
  applyFullscreenPaletteKey,
  buildFullscreenPaletteFrame,
  formatFullscreenPaletteRow,
  fullscreenPaletteStateWithQuery,
  initialFullscreenPaletteState,
  isPaletteSlashLine,
  paletteSlashSeed,
} from "../../src/tui/fullscreen-palette";

describe("fullscreen-palette state", () => {
  test("filter narrows slash rows", () => {
    let state = initialFullscreenPaletteState([]);
    expect(state.items.length).toBeGreaterThan(5);
    const step = applyFullscreenPaletteKey(
      state,
      { kind: "filter", ch: "s" },
      { listRows: 8, customNames: [] },
    );
    expect(step.outcome).toEqual({ kind: "pending" });
    expect(step.state.query).toBe("s");
    expect(step.state.items.some((r) => r.name === "sessions")).toBe(true);
    state = step.state;
    const step2 = applyFullscreenPaletteKey(state, { kind: "filter", ch: "e" }, { listRows: 8, customNames: [] });
    expect(rankPaletteCommands("se", [], 40).some((r) => r.name === "sessions")).toBe(true);
    expect(step2.state.items.map((r) => r.name)).toContain("sessions");
  });

  test("enter selects command and escape cancels", () => {
    const state = fullscreenPaletteStateWithQuery([], "help", 20);
    const pick = applyFullscreenPaletteKey(state, { kind: "confirm" }, { listRows: 5, customNames: [] });
    expect(pick.outcome.kind).toBe("run");
    if (pick.outcome.kind === "run") expect(pick.outcome.commandName).toBe("help");
    const esc = applyFullscreenPaletteKey(state, { kind: "dismiss" }, { listRows: 5, customNames: [] });
    expect(esc.outcome).toEqual({ kind: "cancel" });
  });

  test("palette slash seed parsing", () => {
    expect(isPaletteSlashLine("/palette ses")).toBe(true);
    expect(paletteSlashSeed("/palette ses")).toBe("ses");
    expect(paletteSlashSeed("/commands")).toBe("");
    expect(isPaletteSlashLine("/sessions")).toBe(false);
  });
});

describe("fullscreen-palette layout", () => {
  test("row shows selection caret", () => {
    const rows = rankPaletteCommands("ses", [], 5);
    const row = rows[0];
    expect(row).toBeDefined();
    const line = formatFullscreenPaletteRow(row!, true, 72);
    expect(line.startsWith(">")).toBe(true);
    expect(line).toContain("/sessions");
  });

  test("buildFullscreenPaletteFrame golden diff", () => {
    const state = fullscreenPaletteStateWithQuery([], "theme", 12);
    const buf = buildFullscreenPaletteFrame({ width: 72, height: 10, state });
    const plain = Array.from({ length: buf.height }, (_, row) =>
      buf.cells
        .slice(row * buf.width, (row + 1) * buf.width)
        .map((c) => c.ch)
        .join("")
        .trimEnd(),
    ).join("\n");
    expect(plain).toContain("Command palette");
    expect(plain).toContain("Filter:");
    expect(plain).toContain("theme");
    expect(plain).toContain("/theme");
    const painted = encodeDiffRuns(diffBuffers(null, buf));
    expect(painted.length).toBeGreaterThan(20);
  });
});

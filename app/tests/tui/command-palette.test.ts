import { describe, expect, test } from "bun:test";
import { formatCommandPalette, rankPaletteCommands } from "../../src/tui/command-palette";

describe("command-palette", () => {
  test("lists sessions for ses query", () => {
    const text = formatCommandPalette("ses");
    expect(text).toContain("/sessions");
  });

  test("rankPaletteCommands injects hz://receipt row (ruling 290)", () => {
    const ranked = rankPaletteCommands("hz://receipt/r1", [], 8);
    expect(ranked[0]?.name).toBe("hz://receipt/r1");
  });

  test("rankPaletteCommands matches scrollback formatter", () => {
    const ranked = rankPaletteCommands("pal", [], 5).map((r) => r.name);
    const text = formatCommandPalette("pal", { maxRows: 5 });
    for (const name of ranked) expect(text).toContain(`/${name}`);
  });
});

/**
 * palette-extras.test.ts -- expanded /palette (docs/28 §14).
 * Pure model + rendering; no TTY, no git, no config side effects.
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import {
  parseRecentFilesFromGitStatus,
  paletteToggles,
  renderPaletteExtras,
  type PaletteExtras,
} from "../../src/tui/palette-extras";
import { runInteractiveCommandPalette } from "../../src/tui/interactive-command-palette";

describe("palette extras model", () => {
  test("parses changed file names out of git status --short", () => {
    const out = " M src/a.ts\n?? new.txt\n M src/a.ts\n M \"spaced name.md\"\n";
    expect(parseRecentFilesFromGitStatus(out)).toEqual(["src/a.ts", "new.txt", "spaced name.md"]);
  });

  test("builds quick toggles with current values and their slash commands", () => {
    const toggles = paletteToggles({ plan: "on", autonomy: "regulated", theme: "dark" });
    expect(toggles.map((t) => t.command)).toEqual(["/plan", "/autonomy", "/theme"]);
    expect(toggles.find((t) => t.command === "/plan")?.value).toBe("on");
    expect(toggles.find((t) => t.command === "/theme")?.value).toBe("dark");
  });

  test("renders only the sections that have data", () => {
    const extras: PaletteExtras = {
      shortcuts: [{ key: "Tab", label: "complete" }],
      recentFiles: ["src/a.ts"],
      activeSkills: ["execute-plan"],
      toggles: paletteToggles({ plan: "off" }),
    };
    const text = renderPaletteExtras(extras);
    expect(text).toContain("Shortcuts:");
    expect(text).toContain("Tab");
    expect(text).toContain("Recent files:");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("Active skills:");
    expect(text).toContain("execute-plan");
    expect(text).toContain("Quick toggles:");
    expect(text).toContain("/plan");
    expect(text).toContain("off");
    expect(renderPaletteExtras({})).toBe("");
  });
});

describe("interactive palette shows extras", () => {
  test("extras are printed above the command list and cancel still works", async () => {
    let out = "";
    const stdout = new Writable({
      write(chunk, _, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const chosen = await runInteractiveCommandPalette([], {
      stdin: Readable.from(["0\n"]),
      stdout,
      extras: { recentFiles: ["src/a.ts"], toggles: paletteToggles({ theme: "dark" }) },
    });
    expect(chosen).toBeNull();
    expect(out).toContain("Recent files:");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("Quick toggles:");
    expect(out).toContain("/theme");
  });
});

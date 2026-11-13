import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core/index";
import { defaultConfigPath, persistThemeMode } from "../../src/core/config";
import { runThemeCommand } from "../../src/tui/interactive";
import { createRenderer } from "../../src/tui/render";
import { activeTheme, bgCode, fgCode, onBg, paint, setColorEnabled, setThemeMode, strip, themeMode } from "../../src/tui/style";

const saved = process.env.NO_COLOR;
afterEach(() => {
  setThemeMode("auto");
  setColorEnabled(false);
  if (saved === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = saved;
});

function notices(arg: string): string {
  const chunks: string[] = [];
  runThemeCommand(arg, createRenderer({ wrap: false, out: (c) => void chunks.push(c) }));
  return strip(chunks.join(""));
}

describe("/theme", () => {
  test("dark and light pick the palette at every level", () => {
    setThemeMode("dark");
    const dark = fgCode("ok", 3);
    setThemeMode("light");
    expect(fgCode("ok", 3)).not.toBe(dark);
    expect(bgCode("bgAdd", 2)).toBe("48;5;194");
    expect(activeTheme()).toBe("light");
    setThemeMode("dark");
    expect(bgCode("bgAdd", 2)).toBe("48;5;22");
  });

  test("auto follows detectTheme", () => {
    setThemeMode("auto");
    expect(["dark", "light"]).toContain(activeTheme());
    expect(themeMode()).toBe("auto");
  });

  test("mono drops foregrounds and backgrounds, keeping the text", () => {
    setThemeMode("mono");
    expect(fgCode("ok", 3)).toBe("");
    expect(bgCode("bgAdd", 3)).toBe("");
    expect(paint("err", "x", 3)).toBe("x");
    expect(onBg("bgPanel", "hi", 6, 3)).toBe("hi");
  });

  test("command: show, set, reject, and NO_COLOR is respected", () => {
    delete process.env.NO_COLOR;
    expect(notices("")).toContain("theme: auto");
    expect(notices("light")).toBe("\u00b7 theme: light\n");
    expect(themeMode()).toBe("light");
    expect(notices("mono")).toContain("no colours");
    expect(notices("neon")).toContain('unknown theme "neon"');
    expect(themeMode()).toBe("mono");
    process.env.NO_COLOR = "1";
    expect(notices("dark")).toContain("NO_COLOR is set, so colours stay off");
    expect(notices("")).toContain("(NO_COLOR is set)");
  });

  test("persistThemeMode writes user config and /theme uses it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-theme-home-"));
    try {
      persistThemeMode("dark", home);
      const file = JSON.parse(readFileSync(defaultConfigPath(home), "utf8")) as { theme?: string };
      expect(file.theme).toBe("dark");
      runThemeCommand("light", createRenderer({ out: () => {} }));
      persistThemeMode("light", home);
      expect(JSON.parse(readFileSync(defaultConfigPath(home), "utf8")).theme).toBe("light");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("createRuntime applies theme from user config on startup", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-theme-rt-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-theme-ws-"));
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    try {
      const cfg = defaultConfigPath(home);
      mkdirSync(path.dirname(cfg), { recursive: true });
      writeFileSync(cfg, JSON.stringify({ theme: "light", provider: "mock" }, null, 2) + "\n");
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      setThemeMode("dark");
      const rt = await createRuntime({ workspace, mock: true });
      expect(themeMode()).toBe("light");
      expect(activeTheme()).toBe("light");
      rt.close();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUser === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUser;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

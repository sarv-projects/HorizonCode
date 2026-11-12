import { describe, expect, test } from "bun:test";
import { fullscreenNotImplementedMessage, resolveTuiScreenMode } from "../../src/tui/screen-mode";

describe("tui screen mode", () => {
  test("defaults to scrollback", () => {
    expect(resolveTuiScreenMode({})).toBe("scrollback");
  });

  test("CLI override wins over env", () => {
    expect(resolveTuiScreenMode({ HZ_TUI_MODE: "scrollback" }, "fullscreen")).toBe("fullscreen");
  });

  test("HZ_TUI_MODE recognises aliases", () => {
    expect(resolveTuiScreenMode({ HZ_TUI_MODE: "full" })).toBe("fullscreen");
    expect(resolveTuiScreenMode({ HZ_TUI_MODE: "minimal" })).toBe("scrollback");
  });

  test("fullscreen message points at scrollback default", () => {
    expect(fullscreenNotImplementedMessage()).toContain("scrollback");
    expect(fullscreenNotImplementedMessage()).toContain("5.17");
  });
});

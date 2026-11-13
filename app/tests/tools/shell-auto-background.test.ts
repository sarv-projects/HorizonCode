import { describe, expect, test } from "bun:test";
import { shellAutoBackgroundMs, shellAutoBackgroundNotice } from "../../src/core/shell-auto-background";

describe("shell auto-background (C-7 reduced)", () => {
  test("defaults to 45s unless disabled", () => {
    expect(shellAutoBackgroundMs({ HZ_SHELL_AUTO_BACKGROUND: "0" })).toBeUndefined();
    expect(shellAutoBackgroundMs({})).toBe(45_000);
  });

  test("notice names pid", () => {
    expect(shellAutoBackgroundNotice(42, 45_000)).toContain("pid 42");
  });
});

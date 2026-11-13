import { describe, expect, test } from "bun:test";
import {
  FULLSCREEN_DEFERRED_SLASH_NAMES,
  FULLSCREEN_LOCAL_SLASH_NAMES,
  fullscreenPaletteRunsImmediately,
  isFullscreenDeferredSlash,
  isFullscreenLocalSlash,
  parseSlashInput,
  slashComposerSeed,
} from "../../src/tui/slash-dispatch";

describe("parseSlashInput", () => {
  test("splits name and arg", () => {
    expect(parseSlashInput("/theme dark")).toEqual({ name: "theme", arg: "dark", raw: "/theme dark" });
    expect(parseSlashInput("  /trust  ")).toEqual({ name: "trust", arg: "", raw: "/trust" });
    expect(parseSlashInput("hello")).toBeNull();
  });
});

describe("fullscreen slash dispatch table", () => {
  test("local builtins include snapshot and worktree honesty", () => {
    expect(isFullscreenLocalSlash("snapshot")).toBe(true);
    expect(isFullscreenLocalSlash("worktree")).toBe(true);
  });

  test("local builtins include trust theme copy autonomy", () => {
    for (const name of ["trust", "theme", "copy", "autonomy"]) {
      expect(isFullscreenLocalSlash(name)).toBe(true);
      expect(FULLSCREEN_LOCAL_SLASH_NAMES).toContain(name);
    }
  });

  test("deferred builtins stay out of local set", () => {
    for (const name of ["sessions", "palette", "retry", "model"]) {
      expect(isFullscreenDeferredSlash(name)).toBe(true);
      expect(isFullscreenLocalSlash(name)).toBe(false);
      expect(FULLSCREEN_DEFERRED_SLASH_NAMES).toContain(name);
    }
  });

  test("palette immediate run for bare trust not rename", () => {
    expect(fullscreenPaletteRunsImmediately("trust")).toBe(true);
    expect(fullscreenPaletteRunsImmediately("theme")).toBe(true);
    expect(fullscreenPaletteRunsImmediately("rename")).toBe(false);
  });

  test("slashComposerSeed", () => {
    expect(slashComposerSeed("apply")).toBe("/apply ");
  });
});

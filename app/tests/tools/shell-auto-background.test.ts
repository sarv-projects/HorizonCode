import { afterEach, describe, expect, test } from "bun:test";
import {
  activeAutoBackgrounds,
  backgroundSteerNotice,
  clearAllAutoBackgrounds,
  clearAutoBackground,
  noteAutoBackground,
  shellAutoBackgroundMs,
  shellAutoBackgroundNotice,
} from "../../src/core/shell-auto-background";

afterEach(() => clearAllAutoBackgrounds());

describe("shell auto-background (C-7 reduced)", () => {
  test("defaults to 45s unless disabled", () => {
    expect(shellAutoBackgroundMs({ HZ_SHELL_AUTO_BACKGROUND: "0" })).toBeUndefined();
    expect(shellAutoBackgroundMs({})).toBe(45_000);
  });

  test("notice names pid and directs the steer to the next step boundary", () => {
    const notice = shellAutoBackgroundNotice(42, 45_000);
    expect(notice).toContain("pid 42");
    expect(notice).toContain("next step boundary");
    expect(notice).toContain("keeps running");
  });
});

describe("auto-background registry (C-7 / 490)", () => {
  test("records and clears a backgrounded command; no notice when none live", () => {
    expect(activeAutoBackgrounds()).toHaveLength(0);
    expect(backgroundSteerNotice()).toBeUndefined();
    noteAutoBackground({ pid: 4242, backgroundedAtMs: 45_000, notice: "n" });
    expect(activeAutoBackgrounds()).toHaveLength(1);
    clearAutoBackground(4242);
    expect(activeAutoBackgrounds()).toHaveLength(0);
  });

  test("steer notice names the live pid and says it was left running", () => {
    noteAutoBackground({ pid: 777, backgroundedAtMs: 45_000, notice: "n" });
    const notice = backgroundSteerNotice();
    expect(notice).toBeDefined();
    expect(notice).toContain("777");
    expect(notice).toContain("still running");
    expect(notice).toContain("left running");
  });

  test("multiple backgrounded commands are all named", () => {
    noteAutoBackground({ pid: 1, backgroundedAtMs: 1, notice: "" });
    noteAutoBackground({ pid: 2, backgroundedAtMs: 2, notice: "" });
    const notice = backgroundSteerNotice();
    expect(notice).toContain("2 auto-backgrounded commands");
    expect(notice).toContain("pid 1, 2");
  });
});

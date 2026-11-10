import { afterEach, describe, expect, test } from "bun:test";
import {
  bgCode, blend, charWidth, detectColorLevel, detectTheme, fgCode, nearestIndexed, onBg, paint, pulse,
  setColorEnabled, setColorLevel, strip, truncate, visibleWidth,
} from "../../src/tui/style";
import { footerLine, pulseGlyph, syncEnabled, syncFrame, eraseRegion, SYNC_BEGIN, SYNC_END } from "../../src/tui/live";

afterEach(() => setColorEnabled(false));

describe("colour level detection", () => {
  test("NO_COLOR, dumb and non-TTY are level 0", () => {
    expect(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(0);
    expect(detectColorLevel({ TERM: "dumb" }, true)).toBe(0);
    expect(detectColorLevel({ TERM: "xterm-256color" }, false)).toBe(0);
  });
  test("ladder", () => {
    expect(detectColorLevel({ COLORTERM: "truecolor", TERM: "xterm" }, true)).toBe(3);
    expect(detectColorLevel({ TERM_PROGRAM: "iTerm.app", TERM: "xterm" }, true)).toBe(3);
    expect(detectColorLevel({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, true)).toBe(2);
    expect(detectColorLevel({ TERM: "xterm" }, true)).toBe(1);
    expect(detectColorLevel({ TERM: "weird" }, true)).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: "3" }, false)).toBe(3);
    expect(detectColorLevel({ FORCE_COLOR: "1" }, false)).toBe(1);
  });
  test("theme", () => {
    expect(detectTheme({})).toBe("dark");
    expect(detectTheme({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectTheme({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectTheme({ HZ_THEME: "light" })).toBe("light");
  });
});

describe("role table", () => {
  test("every level", () => {
    expect(fgCode("ok", 3)).toBe("38;2;158;206;106");
    expect(fgCode("ok", 2)).toBe("38;5;149");
    expect(fgCode("ok", 1)).toBe("32");
    expect(fgCode("ok", 0)).toBe("");
    expect(paint("err", "x", 0)).toBe("x");
    expect(paint("err", "x", 1)).toBe("\u001b[31mx\u001b[0m");
    expect(fgCode("muted", 1)).toBe("2");
  });
  test("backgrounds only at 256+", () => {
    expect(bgCode("bgUser", 1)).toBe("");
    expect(bgCode("bgUser", 2)).toBe("48;5;235");
    expect(bgCode("bgUser", 3)).toBe("48;2;36;36;36");
    expect(onBg("bgPanel", "ab", 10, 1)).toBe("ab");
    const row = onBg("bgPanel", "ab", 10, 3);
    expect(visibleWidth(row)).toBe(10);
  });
  test("blend, pulse and quantiser", () => {
    expect(blend([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(pulse(0)).toBe(0);
    expect(pulse(Math.PI / 2 / 0.08)).toBeCloseTo(1, 5);
    expect(nearestIndexed([255, 0, 0])).toBe(196);
    expect(nearestIndexed([128, 128, 128])).toBeGreaterThanOrEqual(232);
  });
  test("pinned level and forced off", () => {
    setColorLevel(2);
    expect(paint("ok", "x")).toBe("\u001b[38;5;149mx\u001b[0m");
    setColorEnabled(false);
    expect(paint("ok", "x")).toBe("x");
  });
});

describe("display width", () => {
  test("wide and combining", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
    expect(visibleWidth("日本語")).toBe(6);
    expect(visibleWidth("e\u0301")).toBe(1);
    expect(visibleWidth("\u001b[31m日\u001b[0m")).toBe(2);
    expect(visibleWidth("\u{1F600}")).toBe(2);
  });
  test("truncate respects columns", () => {
    expect(truncate("日本語日本語", 7)).toBe("日本語\u2026");
    expect(visibleWidth(truncate("日本語日本語", 6))).toBeLessThanOrEqual(6);
    expect(truncate("abcdef", 4)).toBe("abc\u2026");
  });
});

describe("sync output and footer", () => {
  test("sync wrapping and tmux skip", () => {
    expect(syncFrame("x", true)).toBe(SYNC_BEGIN + "x" + SYNC_END);
    expect(syncFrame("x", false)).toBe("x");
    expect(syncEnabled({ TMUX: "/tmp/tmux" })).toBe(false);
    expect(syncEnabled({})).toBe(true);
  });
  test("erase region", () => {
    expect(eraseRegion(1)).toBe("\r\u001b[2K");
    expect(eraseRegion(3)).toBe("\r\u001b[2A\u001b[J");
  });
  test("pulse glyph by level", () => {
    expect(pulseGlyph("x", 5, 0)).toBe("x");
    expect(pulseGlyph("x", 5, 2)).toContain("38;5;141");
    expect(pulseGlyph("x", 0, 3)).not.toBe(pulseGlyph("x", 20, 3));
  });
  const base = { tick: 0, verb: "Reading math.ts", phaseMs: 12_000, turnMs: 111_000, inputTokens: 31_000, esc: true };
  for (const width of [23, 30, 39, 50, 59, 70, 79, 100, 140]) {
    test(`footer fits ${width}`, () => {
      const line = footerLine({ ...base, width });
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    });
  }
  test("footer ladder", () => {
    setColorEnabled(false);
    const wide = strip(footerLine({ ...base, width: 100 }));
    expect(wide).toContain("Reading math.ts\u2026 12s \u00b7 esc to cancel");
    expect(wide.trimEnd().endsWith("1m51s \u21e331k")).toBe(true);
    expect(strip(footerLine({ ...base, width: 70 }))).toContain("12s \u00b7 esc");
    expect(strip(footerLine({ ...base, width: 70 }))).not.toContain("to cancel");
    const mid = strip(footerLine({ ...base, width: 50 }));
    expect(mid).not.toContain("12s");
    expect(mid).toContain("1m51s");
    expect(strip(footerLine({ ...base, width: 22 }))).toHaveLength(1);
    expect(strip(footerLine({ ...base, verb: "Reading", more: 2, width: 100 }))).toContain("Reading + 2 more\u2026");
  });
});

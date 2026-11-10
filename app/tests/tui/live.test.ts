/**
 * live.test.ts — the pure pieces of the animated chat chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { printRichBanner } from "../../src/tui/banner";
import {
  SPINNER_ASCII,
  SPINNER_UNICODE,
  TIPS,
  clockTime,
  composeStatusBar,
  createLive,
  formatDuration,
  formatElapsed,
  formatTokens,
  liveEnabled,
  pickTip,
  readGitBranch,
  spinnerFrame,
  spinnerLine,
  toolVerb,
  turnFooter,
  unicodeLocale,
  userBlock,
} from "../../src/tui/live";
import { colorEnabled, setColorEnabled, strip, visibleWidth } from "../../src/tui/style";

let wasColor = false;
beforeAll(() => {
  wasColor = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(wasColor));

const info = {
  badge: "PLAN",
  model: "mock-1",
  provider: "mock",
  contextPercent: 12.4,
  path: "~/proj/horizon",
  branch: "main",
};

describe("formatting", () => {
  test("elapsed", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(4900)).toBe("4s");
    expect(formatElapsed(111_000)).toBe("1m51s");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
  test("duration", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_400)).toBe("12.4s");
    expect(formatDuration(75_000)).toBe("1m15s");
  });
  test("tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(31_000)).toBe("31k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
  test("clock", () => {
    expect(clockTime(new Date(2024, 0, 1, 6, 8))).toBe("06:08");
  });
});

describe("spinner", () => {
  test("frames cycle and fall back to ascii", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_UNICODE[0]);
    expect(spinnerFrame(10)).toBe(SPINNER_UNICODE[0]);
    expect(spinnerFrame(1, false)).toBe(SPINNER_ASCII[1]);
    expect(spinnerFrame(-1, false)).toBe(SPINNER_ASCII[3]);
  });
  test("locale detection", () => {
    expect(unicodeLocale({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(unicodeLocale({ LANG: "C" })).toBe(false);
    expect(unicodeLocale({})).toBe(false);
  });
  test("verbs follow the running tool", () => {
    expect(toolVerb(undefined)).toBe("Thinking");
    expect(toolVerb("shell", { command: "ls" })).toBe("Running shell");
    expect(toolVerb("read", { path: "src/math.js" })).toBe("Reading math.js");
    expect(toolVerb("edit", { path: "a/b.ts" })).toBe("Editing b.ts");
    expect(toolVerb("glob", { pattern: "**/*.md" })).toBe("Globbing **/*.md");
    expect(toolVerb("weird_tool")).toBe("Running weird_tool");
  });
  test("line", () => {
    expect(spinnerLine({ tick: 0, elapsedMs: 4000, esc: true })).toBe("\u280b Thinking\u2026 4s \u00b7 esc to cancel");
    expect(spinnerLine({ tick: 1, verb: "Running shell", elapsedMs: 2000, esc: false, unicode: false })).toBe(
      "/ Running shell\u2026 2s \u00b7 ctrl+c to cancel",
    );
  });
});

describe("status bar", () => {
  test("full width", () => {
    expect(composeStatusBar(info, 100)).toBe("PLAN \u00b7 mock-1 \u00b7 mock \u00b7 \u25d1 12% \u00b7 ~/proj/horizon \u00b7 \u2442 main");
  });
  test("default mode and no repo or usage", () => {
    expect(composeStatusBar({ ...info, badge: "", contextPercent: undefined, branch: undefined }, 100)).toBe(
      "default \u00b7 mock-1 \u00b7 mock \u00b7 ~/proj/horizon",
    );
  });
  test("drops path first, then provider", () => {
    expect(composeStatusBar(info, 40)).toBe("PLAN \u00b7 mock-1 \u00b7 mock \u00b7 \u25d1 12% \u00b7 \u2442 main");
    expect(composeStatusBar(info, 30)).toBe("PLAN \u00b7 mock-1 \u00b7 \u25d1 12% \u00b7 \u2442 main");
  });
  test("never wider than the terminal", () => {
    for (let w = 10; w <= 120; w += 3) {
      expect(visibleWidth(composeStatusBar(info, w))).toBeLessThanOrEqual(w);
    }
  });
  test("colour keeps the width honest", () => {
    setColorEnabled(true);
    try {
      const bar = composeStatusBar(info, 45);
      expect(bar).toContain("\u001b[");
      expect(visibleWidth(bar)).toBeLessThanOrEqual(45);
      expect(strip(composeStatusBar(info, 100))).toBe(
        "PLAN \u00b7 mock-1 \u00b7 mock \u00b7 \u25d1 12% \u00b7 ~/proj/horizon \u00b7 \u2442 main",
      );
    } finally {
      setColorEnabled(false);
    }
  });
});

describe("blocks and footer", () => {
  test("plain user block without colour", () => {
    expect(userBlock("hello", 40, "06:08", false)).toEqual(["\u276f hello"]);
  });
  test("shaded block is full width with a right-aligned time", () => {
    const lines = userBlock("hello", 40, "06:08", true);
    expect(lines.length).toBe(3);
    for (const l of lines) expect(visibleWidth(l)).toBe(40);
    expect(strip(lines[1]).trimEnd().endsWith("06:08")).toBe(true);
    expect(lines[1]).toContain("48;5;236");
  });
  test("footer", () => {
    expect(turnFooter({ ms: 12_400, tools: 3, inputTokens: 1234 })).toBe("\u00b7 12.4s \u00b7 3 tools \u00b7 \u21911.2k tok");
    expect(turnFooter({ ms: 800, tools: 1 })).toBe("\u00b7 800ms \u00b7 1 tool");
    const f = turnFooter({ ms: 800, tools: 0, time: "06:08", width: 40 });
    expect(visibleWidth(f)).toBe(39);
    expect(f.endsWith("06:08")).toBe(true);
  });
});

describe("capability and git", () => {
  test("liveEnabled is false for pipes, NO_COLOR and dumb terminals", () => {
    expect(liveEnabled({ isTTY: false })).toBe(false);
    expect(liveEnabled(undefined)).toBe(false);
    setColorEnabled(true);
    const saved = { ...process.env };
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      expect(liveEnabled({ isTTY: true })).toBe(true);
      process.env.NO_COLOR = "1";
      expect(liveEnabled({ isTTY: true })).toBe(false);
      delete process.env.NO_COLOR;
      process.env.TERM = "dumb";
      expect(liveEnabled({ isTTY: true })).toBe(false);
    } finally {
      process.env.TERM = saved.TERM;
      if (saved.NO_COLOR !== undefined) process.env.NO_COLOR = saved.NO_COLOR;
      setColorEnabled(false);
    }
  });
  test("branch from .git/HEAD", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-live-"));
    try {
      expect(readGitBranch(path.join(dir, "nope"))).toBeUndefined();
      mkdirSync(path.join(dir, ".git"));
      writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
      mkdirSync(path.join(dir, "sub"));
      expect(readGitBranch(path.join(dir, "sub"))).toBe("feat/x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("tips are data and pickTip is stable", () => {
    expect(TIPS.length).toBeGreaterThan(5);
    expect(pickTip(3)).toBe(TIPS[3]);
    expect(pickTip(TIPS.length + 2)).toBe(TIPS[2]);
  });
});

describe("live region", () => {
  test("disabled live writes nothing", () => {
    const out: string[] = [];
    const live = createLive({
      enabled: false,
      write: (s) => void out.push(s),
      status: () => info,
      atLineStart: () => true,
      typed: () => false,
      esc: true,
    });
    live.showIdle();
    live.beginTurn();
    live.toolStart("shell", {});
    const stats = live.endTurn();
    live.dispose();
    expect(out).toEqual([]);
    expect(stats.tools).toBe(1);
  });
  test("enabled live draws, erases, and stops its timer", async () => {
    const out: string[] = [];
    let clock = 1000;
    const live = createLive({
      enabled: true,
      write: (s) => void out.push(s),
      status: () => info,
      atLineStart: () => true,
      typed: () => false,
      esc: true,
      now: () => clock,
    });
    live.beginTurn();
    expect(strip(out.join(""))).toContain("Thinking\u2026 0s \u00b7 esc to cancel");
    live.toolStart("read", { path: "math.js" });
    clock = 3000;
    await new Promise((r) => setTimeout(r, 250));
    expect(strip(out.join(""))).toContain("Reading math.js\u2026 2s");
    const stats = live.endTurn();
    expect(stats).toMatchObject({ ms: 2000, tools: 1 });
    expect(out[out.length - 1]).toBe("\r\u001b[2K");
    expect(out.join("")).not.toContain("\n");
    const n = out.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(out.length).toBe(n);
    live.dispose();
  });
});

describe("idle status line", () => {
  test("printed once per prompt, deduped until the transcript changes, never with cursor moves", () => {
    const out: string[] = [];
    const live = createLive({ enabled: true, write: (s) => void out.push(s), status: () => info, atLineStart: () => true, typed: () => false, esc: true });
    live.showIdle();
    live.showIdle();
    expect(out.length).toBe(1);
    expect(out[0].endsWith("\n")).toBe(true);
    expect(out[0]).not.toContain("\u001b[1A");
    live.erase();
    live.showIdle();
    expect(out.length).toBe(2);
    live.dispose();
  });
});

describe("rich banner", () => {
  test("wordmark, facts and tip", () => {
    const chunks: string[] = [];
    printRichBanner(
      { version: "0.1.0", model: "m", provider: "p", workspace: "/w", kernel: "trusted" },
      { out: (c) => void chunks.push(c), width: 80, tip: "/plan stages edits" },
    );
    const text = chunks.join("");
    expect(text.split("\n").length - 1).toBe(5);
    expect(text).toContain("HorizonCode v0.1");
    expect(text).toContain("tip /plan stages edits");
  });
});

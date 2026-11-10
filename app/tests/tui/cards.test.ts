import { afterEach, describe, expect, test } from "bun:test";
import {
  cardDuration, describeTool, lineDelta, foldLabel, foldLine, patchStats, resultLine, shellFooter, shellHeader, shellOutputLines,
  shortPath, subagentGroupLines, subagentLine, toolCardLines, type CardStyle,
} from "../../src/tui/cards";
import { createRenderer } from "../../src/tui/render";
import { setColorEnabled, strip, visibleWidth, type ColorLevel } from "../../src/tui/style";
import { PLAIN_SCRIPT } from "./fixtures/plain-events";
import { readFileSync } from "node:fs";

afterEach(() => setColorEnabled(false));

const WIDTHS = [24, 40, 60, 80, 120];
const LEVELS: ColorLevel[] = [0, 1, 2, 3];
const st = (width: number, level: ColorLevel = 0, unicode = true): CardStyle => ({ width, level, unicode });

describe("small formatters", () => {
  test("durations", () => {
    expect(cardDuration(10)).toBe("<0.1s");
    expect(cardDuration(200)).toBe("0.2s");
    expect(cardDuration(3200)).toBe("3.2s");
    expect(cardDuration(20_000)).toBe("20s");
    expect(cardDuration(111_000)).toBe("1m51s");
    expect(cardDuration(7_500_000)).toBe("2h5m");
  });
  test("short paths keep the basename and parent", () => {
    expect(shortPath("src/a.ts")).toBe("src/a.ts");
    expect(shortPath("/very/long/workspace/path/with/many/parts/src/tui/render.ts", 30)).toBe("\u2026/tui/render.ts");
    expect(shortPath("/a/b/averyveryverylongfilename-that-never-ends-here.ts", 20).length).toBeLessThanOrEqual(20);
  });
  test("patch stats", () => {
    expect(patchStats("*** Update File: a\n-x\n+y\n+z\n*** Add File: b\n+q")).toEqual({ add: 3, del: 1, files: 2 });
  });
});

describe("tool descriptions never invent numbers", () => {
  test("read", () => {
    expect(describeTool("read", { path: "a.ts" }).extra).toBe("");
    expect(describeTool("read", { path: "a.ts" }, { count: 120 }).extra).toBe("(120 lines)");
    expect(describeTool("read", { path: "a.ts", offset: 10, limit: 41 }).extra).toBe("(10-50)");
  });
  test("search, glob, edit", () => {
    expect(describeTool("grep", { pattern: "TODO", path: "src/" }, { count: 14 })).toMatchObject({ object: '"TODO" in src/', extra: "(14 matches)" });
    expect(describeTool("glob", { pattern: "**/*.ts" }, { count: 1 }).extra).toBe("(1 file)");
    expect(describeTool("edit", { path: "a", old: "x\ny", new: "z" }).delta).toEqual({ add: 1, del: 2 });
    expect(describeTool("edit", { path: "a", old: "a\nb\n", new: "a\nb\n\nc\n" }).delta).toEqual({ add: 2, del: 0 });
    expect(lineDelta("same", "same")).toEqual({ add: 0, del: 0 });
    expect(describeTool("write", { path: "a", content: "1\n2\n3\n" }).delta).toEqual({ add: 3, del: 0 });
  });
});

describe("tool cards at widths and levels", () => {
  const cases = [
    { name: "read", args: { path: "src/tui/render.ts" }, status: "ok", detail: { durationMs: 200, count: 120 } },
    { name: "grep", args: { pattern: "TODO", path: "src/" }, status: "ok", detail: { durationMs: 400, count: 14 } },
    { name: "edit", args: { path: "/some/very/deep/workspace/dir/src/math.ts", old: "a", new: "b\nc" }, status: "ok", detail: { durationMs: 200 } },
    { name: "read", args: { path: "nope.ts" }, status: "error", summary: "file not found: nope.ts and a very long explanation that must wrap", detail: { durationMs: 12 } },
  ] as const;
  for (const w of WIDTHS)
    for (const level of LEVELS)
      for (const unicode of [true, false])
        test(`fits ${w} level ${level} ${unicode ? "unicode" : "ascii"}`, () => {
          for (const c of cases) {
            const lines = toolCardLines({ ...c, detail: { ...c.detail } } as never, st(w, level, unicode));
            for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
            if (level === 0) for (const l of lines) expect(l).toBe(strip(l));
            if (!unicode) for (const l of lines) expect(strip(l)).toMatch(/^[\x20-\x7e]*$/);
          }
        });
  test("exact wide layout", () => {
    const [line] = toolCardLines({ name: "read", args: { path: "src/a.ts" }, status: "ok", detail: { durationMs: 200, count: 120 } }, st(80));
    expect(line).toBe("\u25c6 Read src/a.ts (120 lines)" + " ".repeat(80 - 27 - 4) + "0.2s");
    expect(visibleWidth(line)).toBe(80);
  });
  test("narrow puts the duration inline", () => {
    const [line] = toolCardLines({ name: "read", args: { path: "src/a.ts" }, status: "ok", detail: { durationMs: 200 } }, st(40));
    expect(line).toBe("\u25c6 Read src/a.ts 0.2s");
  });
  test("edit carries a coloured +A/-D", () => {
    const [line] = toolCardLines({ name: "edit", args: { path: "a.ts", old: "x", new: "y\nz" }, status: "ok", detail: { durationMs: 200 } }, st(80, 3));
    expect(line).toContain("\u001b[38;2;158;206;106m+2");
    expect(line).toContain("\u001b[38;2;247;118;142m-1");
    expect(strip(line)).toContain("Edit a.ts +2/-1");
  });
  test("error line", () => {
    const lines = toolCardLines({ name: "glob", args: { pattern: "*" }, status: "error", summary: "bad pattern" }, st(80));
    expect(lines[1]).toBe("  \u2717 error: bad pattern");
  });
  test("result line for header-first tools", () => {
    expect(resultLine({ name: "edit", args: { path: "a", old: "x", new: "y" }, status: "ok", detail: { durationMs: 200 } }, st(80))[0]).toBe("  \u2514 +1/-1 \u00b7 0.2s");
    expect(resultLine({ name: "write", args: { path: "a", content: "q" }, status: "error", summary: "denied" }, st(80))[0]).toBe("  \u2717 error: denied");
  });
});

describe("shell card", () => {
  test("header", () => {
    expect(shellHeader("npm test -- --reporter=dot", st(80))).toBe("$ npm test -- --reporter=dot");
    expect(shellHeader("a\nb\nc", st(80))).toBe("$ a \u23ce +2 lines");
    expect(visibleWidth(shellHeader("x".repeat(300), st(40)))).toBeLessThanOrEqual(40);
    expect(shellHeader("ls", st(80, 3))).toContain("\u001b[38;2;125;207;255mls");
  });
  test("output collapses to first 2, marker, last 3", () => {
    const out = Array.from({ length: 190 }, (_, i) => `line ${i + 1}`).join("\n");
    const rows = shellOutputLines(out, st(80)).map(strip);
    expect(rows).toEqual(["  \u258e line 1", "  \u258e line 2", "  \u258e \u2026 +185 lines", "  \u258e line 188", "  \u258e line 189", "  \u258e line 190"]);
  });
  test("short output shows everything; control codes are stripped; rows clipped", () => {
    expect(shellOutputLines("a\n\u001b[31mred\u001b[0m\nb", st(80)).map(strip)).toEqual(["  \u258e a", "  \u258e red", "  \u258e b"]);
    for (const w of WIDTHS) for (const r of shellOutputLines("x".repeat(500) + "\n".repeat(1) + "y", st(w, 3))) expect(visibleWidth(r)).toBeLessThanOrEqual(w);
  });
  test("panel background only at 256 and up", () => {
    expect(shellOutputLines("a", st(40, 1))[0]).not.toContain("48;");
    expect(shellOutputLines("a", st(40, 2))[0]).toContain("48;5;234");
    expect(visibleWidth(shellOutputLines("a", st(40, 3))[0] ?? "")).toBe(40);
  });
  test("footer", () => {
    expect(shellFooter({ status: "ok", exitCode: 0, durationMs: 4200 }, st(80))).toBe("  \u2514 4.2s");
    expect(shellFooter({ status: "ok", exitCode: 1, durationMs: 4200 }, st(80))).toBe("  \u2514 exit 1 \u00b7 4.2s");
    expect(shellFooter({ status: "ok", exitCode: 1, durationMs: 4200 }, st(80, 1))).toContain("\u001b[31m");
  });
});

describe("folded runs", () => {
  test("labels use the verb vocabulary", () => {
    const items = [{ name: "read" }, { name: "read" }, { name: "grep" }, { name: "read" }, { name: "ast_search" }];
    expect(foldLabel(items)).toBe("Read 3 files, Searched 2 patterns");
    expect(foldLabel([{ name: "read" }])).toBe("Read 1 file");
  });
  test("line with total time", () => {
    const line = foldLine([{ name: "read", durationMs: 500 }, { name: "grep", durationMs: 700 }], st(60));
    expect(strip(line).startsWith("\u25c6 Read 1 file, Searched 1 pattern")).toBe(true);
    expect(strip(line).endsWith("1.2s")).toBe(true);
    for (const w of WIDTHS) expect(visibleWidth(foldLine([{ name: "read", durationMs: 1 }], st(w)))).toBeLessThanOrEqual(w);
  });
});

describe("subagent lines", () => {
  test("running and completed in Grok wording", () => {
    expect(subagentLine({ state: "running", task: "Map mobile project", activity: "Listing /mnt/c" }, st(100))).toBe(
      "\u25c6 Subagent running: \u201cMap mobile project\u201d \u00b7 Listing /mnt/c",
    );
    expect(subagentLine({ state: "completed", task: "Map frontend project", ms: 20_000 }, st(100))).toBe(
      "\u25c6 Subagent completed in 20s: \u201cMap frontend project\u201d",
    );
    expect(subagentLine({ state: "failed", task: "t", ms: 12_000, reason: "timeout" }, st(100))).toBe("\u25c6 Subagent failed in 12s (timeout): \u201ct\u201d");
  });
  test("always fits", () => {
    for (const w of WIDTHS)
      for (const state of ["running", "completed", "failed"] as const)
        expect(visibleWidth(subagentLine({ state, task: "x".repeat(200), activity: "y".repeat(80), profile: "explore", ms: 5000 }, st(w)))).toBeLessThanOrEqual(w);
  });
  test("group rows", () => {
    const rows = [
      { state: "running" as const, label: "Map mobile project", activity: "Listing /mnt/c", ms: 134_000 },
      { state: "completed" as const, label: "Map frontend project", ms: 20_000 },
    ];
    const lines = subagentGroupLines(rows, st(80), "\u280b").map(strip);
    expect(lines[0]).toBe("\u25be Subagents 2");
    expect(lines[1].startsWith("  \u280b Map mobile project \u00b7 Listing /mnt/c")).toBe(true);
    expect(lines[1].endsWith("2m14s")).toBe(true);
    expect(lines[2].startsWith("  \u2713 Map frontend project")).toBe(true);
    for (const w of [40, 60, 80, 120]) for (const l of subagentGroupLines(rows, st(w), "\u280b")) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    expect(subagentGroupLines(rows, st(30), "x")).toEqual([]);
  });
  test("row cap collapses", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ state: "running" as const, label: `t${i}`, ms: 1000 }));
    const lines = subagentGroupLines(rows, st(80), "x").map(strip);
    expect(lines.length).toBe(7);
    expect(lines[6].trim()).toBe("\u25b8 show 3 more");
  });
});

describe("renderer", () => {
  test("non-rich output is byte-identical to the pre-redesign renderer", () => {
    setColorEnabled(false);
    const out: string[] = [];
    const r = createRenderer({ wrap: true, out: (c) => void out.push(c) });
    for (const ev of PLAIN_SCRIPT) r.handle(ev);
    r.ensureLineStart();
    r.line("l");
    r.notice("n");
    r.error("e");
    expect(out.join("")).toBe(readFileSync(new URL("./fixtures/plain-events.expected.txt", import.meta.url), "utf8"));
  });

  function rich(now: () => number) {
    const out: string[] = [];
    const r = createRenderer({ wrap: true, rich: true, level: 0, unicode: true, out: (c) => void out.push(c), now });
    return { r, text: () => out.join("") };
  }

  test("read-only runs fold at 4 and print individually below that", () => {
    let t = 0;
    const a = rich(() => t);
    for (let i = 0; i < 5; i++) {
      a.r.handle({ type: "tool.card", callId: `r${i}`, name: "read", args: { path: `f${i}.ts` }, status: "running" });
      t += 100;
      a.r.handle({ type: "tool.card", callId: `r${i}`, name: "read", args: { path: `f${i}.ts` }, status: "ok", summary: "x" });
    }
    expect(a.text()).toBe("");
    a.r.handle({ type: "assistant.delta", text: "done\n" });
    expect(a.text().split("\n")[0]).toContain("\u25c6 Read 5 files");
    const b = rich(() => t);
    for (let i = 0; i < 2; i++) {
      b.r.handle({ type: "tool.card", callId: `r${i}`, name: "read", args: { path: `f${i}.ts` }, status: "running" });
      b.r.handle({ type: "tool.card", callId: `r${i}`, name: "read", args: { path: `f${i}.ts` }, status: "ok", summary: "x" });
    }
    b.r.handle({ type: "turn.done" });
    expect(b.text().split("\n").filter((l) => l.startsWith("\u25c6 Read f")).length).toBe(2);
  });

  test("shell: header at start, panel and footer at the end", () => {
    let t = 0;
    const a = rich(() => t);
    a.r.handle({ type: "tool.card", callId: "s", name: "shell", args: { command: "seq 1 20" }, status: "running" });
    expect(a.text()).toBe("$ seq 1 20\n");
    a.r.handle({
      type: "tool.card", callId: "s", name: "shell", args: { command: "seq 1 20" }, status: "ok", summary: "1",
      detail: { durationMs: 4200, exitCode: 0, output: Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") },
    });
    expect(a.text()).toBe("$ seq 1 20\n  \u258e 1\n  \u258e 2\n  \u258e \u2026 +15 lines\n  \u258e 18\n  \u258e 19\n  \u258e 20\n  \u2514 4.2s\n");
  });

  test("subagent: start line, live group, completion line", () => {
    let t = 0;
    const a = rich(() => t);
    a.r.handle({ type: "tool.card", callId: "a1", name: "agent", args: { description: "Map frontend" }, status: "running" });
    a.r.handle({ type: "subagent.event", agentId: "c1", name: "agent", depth: 1, profile: "explore", event: { type: "tool.card", callId: "q", name: "read", args: { path: "x/y.ts" }, status: "running" } });
    t = 5000;
    const live = a.r.liveLines?.(0, 80) ?? [];
    expect(live.map(strip)[0]).toBe("\u25be Subagents 1");
    expect(strip(live[1] ?? "")).toContain("Map frontend \u00b7 Reading y.ts");
    t = 20_000;
    a.r.handle({ type: "tool.card", callId: "a1", name: "agent", args: { description: "Map frontend" }, status: "ok", summary: "done" });
    const lines = a.text().split("\n");
    expect(lines[0]).toBe("\u25c6 Subagent running: \u201cMap frontend\u201d");
    expect(lines[1]).toBe("\u25c6 Subagent completed in 20s: \u201cMap frontend\u201d");
    expect(a.text()).not.toContain("\u2502");
    t = 30_000;
    expect(a.r.liveLines?.(0, 80)).toEqual([]);
  });

  test("rich assistant text is rendered as markdown and finished by the next event", () => {
    const a = rich(() => 0);
    a.r.handle({ type: "assistant.delta", text: "Here is **bold** and `code`.\n- one\n" });
    a.r.handle({ type: "assistant.delta", text: "- tw" });
    expect(a.text()).toBe("Here is bold and code.\n  \u2022 one\n");
    a.r.handle({ type: "assistant.delta", text: "o" });
    a.r.handle({ type: "tool.card", callId: "g", name: "glob", args: { pattern: "*" }, status: "running" });
    expect(a.text()).toBe("Here is bold and code.\n  \u2022 one\n  \u2022 two\n");
    a.r.handle({ type: "assistant.done", text: "ignored" });
    expect(a.text().endsWith("two\n")).toBe(true);
  });

  test("done-only text is rendered too, and a slow plain line is released after 150 ms", async () => {
    const a = rich(() => 0);
    a.r.handle({ type: "assistant.done", text: "# Hi\nbody" });
    expect(a.text()).toBe("Hi\nbody\n");
    const b = rich(() => 0);
    b.r.handle({ type: "assistant.delta", text: "slow streaming words here" });
    expect(b.text()).toBe("");
    await new Promise((r) => setTimeout(r, 250));
    expect(b.text()).toBe("slow streaming words ");
    b.r.handle({ type: "assistant.done", text: "" });
    expect(b.text()).toBe("slow streaming words here\n");
  });

  test("the rich renderer exposes liveLines only when rich", () => {
    expect(createRenderer({ out: () => {} }).liveLines).toBeUndefined();
  });
});

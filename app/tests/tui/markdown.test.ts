import { describe, expect, test } from "bun:test";
import { createMarkdownStream, highlight, hyperlinksEnabled, renderInline, renderTable } from "../../src/tui/markdown";
import { strip, visibleWidth, type ColorLevel } from "../../src/tui/style";

const ctx = (level: ColorLevel = 0, unicode = true, hyperlinks = false) => ({ level, unicode, hyperlinks });
function render(doc: string, width = 80, level: ColorLevel = 0, unicode = true): string {
  const md = createMarkdownStream({ width, level, unicode, hyperlinks: false });
  return md.push(doc) + md.end();
}

const DOC = [
  "# Title here",
  "",
  "Some **bold** and *italic* and `code` text with a [link](https://example.com/x) and ~~gone~~.",
  "",
  "## Section",
  "- first item",
  "- [x] done task",
  "- [ ] open task",
  "1. one",
  "2) two",
  "> quoted *words*",
  "---",
  "```ts",
  "const x: number = 42; // answer",
  "function f(a) { return \"s\"; }",
  "```",
  "| a | bb |",
  "|---|----|",
  "| 1 | 22 |",
  "",
  "plain tail without newline",
].join("\n");

describe("inline", () => {
  test("level 0 strips markers", () => {
    const c = ctx(0);
    expect(renderInline("a **b** *c* _d_ `e` ~~f~~", c)).toBe("a b c d e f");
    expect(renderInline("[t](https://x.y)", c)).toBe("t (https://x.y)");
    expect(renderInline("[https://x.y](https://x.y)", c)).toBe("https://x.y");
  });
  test("unmatched markers stay literal", () => {
    const c = ctx(0);
    expect(renderInline("2 * 3 = 6 and a_b_c and **open", c)).toBe("2 * 3 = 6 and a_b_c and **open");
    expect(renderInline("snake_case_name", c)).toBe("snake_case_name");
    expect(renderInline("\\*not italic\\*", c)).toBe("*not italic*");
  });
  test("styles at level 3", () => {
    expect(renderInline("**b**", ctx(3))).toBe("\u001b[1mb\u001b[22m");
    expect(renderInline("`e`", ctx(3))).toContain("\u001b[1;38;2;58;149;171me");
    expect(renderInline("*i*", ctx(2))).toBe("\u001b[3mi\u001b[23m");
  });
  test("osc8 links only when enabled", () => {
    expect(renderInline("[t](https://x.y/z)", ctx(1, true, true))).toContain("\u001b]8;;https://x.y/z\u001b\\");
    expect(renderInline("[t](https://x.y/z)", ctx(1, true, false))).not.toContain("\u001b]8");
    expect(renderInline("[t](javascript:alert(1))", ctx(1, true, true))).not.toContain("\u001b]8");
    expect(hyperlinksEnabled({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(hyperlinksEnabled({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(hyperlinksEnabled({ HZ_HYPERLINKS: "1" })).toBe(true);
  });
});

describe("blocks", () => {
  test("document at level 0", () => {
    expect(render(DOC)).toBe(
      [
        "Title here",
        "",
        "Some bold and italic and code text with a link (https://example.com/x) and gone.",
        "",
        "Section",
        "  \u2022 first item",
        "  \u2611 done task",
        "  \u2610 open task",
        "  1. one",
        "  2. two",
        "\u2502 quoted words",
        "\u2500".repeat(60),
        "  \u258e const x: number = 42; // answer",
        "  \u258e function f(a) { return \"s\"; }",
        "\u250c\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2510",
        "\u2502 a \u2502 bb \u2502",
        "\u251c\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2524",
        "\u2502 1 \u2502 22 \u2502",
        "\u2514\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2518",
        "",
        "plain tail without newline",
        "",
      ].join("\n"),
    );
  });
  test("ascii fallback", () => {
    const out = render(DOC, 80, 0, false);
    expect(out).toMatch(/^[\x00-\x7f]*$/);
    expect(out).toContain("+---+----+");
    expect(out).toContain("  * first item");
  });
  test("headings get a blank line before when needed", () => {
    expect(render("para\n## H\ntext")).toBe("para\n\nH\ntext\n");
  });
  test("an unterminated fence closes cleanly", () => {
    expect(render("```py\nx = 1")).toBe("  \u258e x = 1\n");
  });
  test("tables that do not fit stay raw", () => {
    const out = render("| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbb |\n|---|---|\n| 1 | 2 |", 30);
    expect(out).toContain("| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbb |");
  });
  test("code blocks: panel background at 256+, bar below, rows exactly width wide", () => {
    for (const w of [40, 80, 120]) {
      const out = render("```js\nconst a = 1;\n" + "x".repeat(300) + "\n```", w, 3);
      for (const l of out.split("\n").filter((x) => x !== "" && !strip(x).includes("\u256d"))) expect(visibleWidth(l)).toBe(w);
    }
    expect(render("```js\nlet a\n```", 80, 1)).toContain("\u258e");
    expect(render("```js\nlet a\n```", 80, 1)).not.toContain("48;");
    expect(render("```js\nlet a\n```", 80, 2)).toContain("48;5;234");
  });
  test("every produced line fits the width", () => {
    for (const w of [24, 40, 60, 80, 120])
      for (const level of [0, 1, 2, 3] as ColorLevel[])
        for (const l of render(DOC, w, level).split("\n")) if (!/^\s*[a-z]+ [a-z ]*$/.test(strip(l)) && !strip(l).startsWith("Some")) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
  });
});

describe("highlighter", () => {
  test("keywords, strings, numbers, comments by role", () => {
    const out = highlight("ts", 'const s = "x"; // c 1', ctx(3));
    expect(strip(out)).toBe('const s = "x"; // c 1');
    expect(out).toContain("\u001b[38;2;187;154;247mconst"); // accent keyword
    expect(out).toContain("\u001b[38;2;158;206;106m\"x\""); // ok string
    expect(out).toContain("\u001b[3;38;2;108;108;108m// c 1"); // muted italic comment
  });
  test("plain for unknown languages and level 0; diff colours", () => {
    expect(highlight("brainfuck", "+-[]", ctx(3))).toBe("+-[]");
    expect(highlight("ts", "const a", ctx(0))).toBe("const a");
    expect(highlight("diff", "+added", ctx(3))).toContain("38;2;158;206;106");
    expect(highlight("diff", "-gone", ctx(3))).toContain("38;2;247;118;142");
  });
  test("never changes the text", () => {
    const samples = ['x = "unterminated', "echo $HOME # note", "fn main() -> u32 { 0x1F }", '{"a": [1, 2.5, null]}', "日本語 = 1"];
    for (const s of samples) for (const l of ["py", "sh", "rs", "json", "go", "yaml", "ts"]) expect(strip(highlight(l, s, ctx(3)))).toBe(s);
  });
});

describe("streaming", () => {
  for (const level of [0, 3] as ColorLevel[])
    test(`chunk boundaries never change the output (level ${level})`, () => {
      const whole = render(DOC, 80, level);
      for (let i = 0; i <= DOC.length; i++) {
        const md = createMarkdownStream({ width: 80, level, unicode: true, hyperlinks: false });
        const out = md.push(DOC.slice(0, i)) + md.push(DOC.slice(i)) + md.end();
        expect(out).toBe(whole);
      }
    });
  test("byte-at-a-time equals whole", () => {
    const md = createMarkdownStream({ width: 80, level: 2, unicode: true, hyperlinks: false });
    let out = "";
    for (const ch of DOC) out += md.push(ch);
    expect(out + md.end()).toBe(render(DOC, 80, 2));
  });
  test("completed lines come out at the newline, the tail waits", () => {
    const md = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    expect(md.push("hello **wor")).toBe("");
    expect(md.push("ld**\nnext")).toBe("hello world\n");
    expect(md.end()).toBe("next\n");
  });
  test("flushPartial releases plain prose but never a block opener or an open marker", () => {
    const a = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    a.push("The quick brown fox jum");
    expect(a.flushPartial()).toBe("The quick brown fox ");
    expect(a.midLine).toBe(true);
    expect(a.push("ps over\n")).toBe("jumps over\n");
    expect(a.midLine).toBe(false);
    const b = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    b.push("- list item that is long");
    expect(b.flushPartial()).toBe("");
    b.push("# not yet");
    const c = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    c.push("alpha beta **bold wor");
    expect(c.flushPartial()).toBe("alpha beta ");
    expect(c.flushPartial()).toBe("");
    expect(c.push("ds** end\n")).toBe("bold words end\n");
  });
  test("no flush inside a fence", () => {
    const md = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    md.push("```js\nconst a = 1 + 2");
    expect(md.flushPartial()).toBe("");
  });
});

describe("table renderer", () => {
  test("columns align with inline styling", () => {
    const rows = ["| **a** | b |", "|---|---|", "| xx | `y` |"];
    const lines = renderTable(rows, 80, ctx(0)).map(strip);
    expect(lines[1]).toBe("\u2502 a  \u2502 b \u2502");
    expect(lines[3]).toBe("\u2502 xx \u2502 y \u2502");
  });
});

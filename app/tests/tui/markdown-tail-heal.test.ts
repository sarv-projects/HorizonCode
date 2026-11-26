/**
 * markdown-tail-heal.test.ts — Group F streaming markdown tail-healing
 * (opencode patchmark ADAPT). Pure helper: close incomplete inline markers.
 */
import { describe, expect, test } from "bun:test";
import { healStreamingInline, computeTailHeal } from "../../src/tui/markdown-tail-heal";
import { createMarkdownStream } from "../../src/tui/markdown";

describe("streaming markdown tail-heal (patchmark port)", () => {
  test("computeTailHeal names the unclosed markers in order", () => {
    expect(computeTailHeal("**bold *ital")).toEqual(["*", "**"]);
    expect(computeTailHeal("`code")).toEqual(["`"]);
    expect(computeTailHeal("~~strike")).toEqual(["~~"]);
    expect(computeTailHeal("plain text")).toEqual([]);
  });

  test("healStreamingInline appends closing markers without touching complete text", () => {
    expect(healStreamingInline("**bold *ital")).toBe("**bold *ital***"); // closes * then **
    expect(healStreamingInline("plain text")).toBe("plain text");
    expect(healStreamingInline("**done** and *open")).toBe("**done** and *open*");
  });

  test("an escaped marker is not treated as open", () => {
    expect(computeTailHeal("literal \\* star")).toEqual([]);
    expect(healStreamingInline("literal \\* star")).toBe("literal \\* star");
  });

  test("wired: healPartial option closes markers in flushPartial; default is unchanged", () => {
    const healed = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false, healPartial: true });
    healed.push("*italic ");
    expect(healed.flushPartial()).toBe("*italic *"); // open * closed for display
    // default stream still refuses to show text past an open marker
    const plain = createMarkdownStream({ width: 80, level: 0, unicode: true, hyperlinks: false });
    plain.push("*italic ");
    expect(plain.flushPartial()).toBe("");
  });

  test("fenced code content is not healed (caller passes prose only)", () => {
    // The helper is intentionally prose-only; a fence must be excluded by the
    // caller. Here an unterminated backtick in prose IS healed.
    expect(healStreamingInline("a `tick")).toBe("a `tick`");
  });
});

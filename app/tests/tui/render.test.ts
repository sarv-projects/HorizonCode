/**
 * render.test.ts — the line shapes the chat surface produces.
 *
 * The renderer is pure (events in, text out), so this is the cheap half of the
 * UI contract: glyphs, the tool result line, sanitised model output.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { compactArgs, createRenderer } from "../../src/tui/render";
import { setColorEnabled } from "../../src/tui/style";

const CARD = "\u23fa"; // ⏺ the filled circle a running tool card opens with
const CORNER = "\u2514"; // └ the corner the result line hangs from

beforeAll(() => {
  // Assert on the text, not on escape sequences (NO_COLOR everywhere else too).
  setColorEnabled(false);
});

function captured() {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
  return { renderer, text: () => chunks.join("") };
}

describe("tool cards", () => {
  test("a running tool is one line: circle glyph, name and arguments", () => {
    const c = captured();

    c.renderer.handle({ type: "tool.card", callId: "c1", name: "glob", args: { pattern: "*" }, status: "running" });

    expect(c.text()).toBe(`${CARD} glob({"pattern":"*"})\n`);
  });

  test("a finished tool is a corner line under the card", () => {
    const ok = captured();
    ok.renderer.handle({ type: "tool.card", callId: "c1", name: "glob", args: {}, status: "ok", summary: "alpha.txt" });
    expect(ok.text()).toBe(`  ${CORNER} ok: alpha.txt\n`);

    const bad = captured();
    bad.renderer.handle({ type: "tool.card", callId: "c1", name: "glob", args: {}, status: "error", summary: "no such file" });
    expect(bad.text()).toBe(`  ${CORNER} error: no such file\n`);
  });

  test("a multi-line summary stays on one line", () => {
    const c = captured();

    c.renderer.handle({ type: "tool.card", callId: "c1", name: "read", args: {}, status: "ok", summary: "first line\nsecond line" });

    expect(c.text()).toBe(`  ${CORNER} ok: first line\n`);
  });

  test("a card that follows partial text starts on its own line", () => {
    const c = captured();

    c.renderer.handle({ type: "assistant.delta", text: "looking now" });
    c.renderer.handle({ type: "tool.card", callId: "c1", name: "glob", args: {}, status: "running" });

    expect(c.text()).toBe(`looking now\n${CARD} glob\n`);
  });
});

describe("assistant text", () => {
  test("deltas stream through and the finished text is not repeated", () => {
    const c = captured();

    c.renderer.handle({ type: "assistant.delta", text: "hel" });
    c.renderer.handle({ type: "assistant.delta", text: "lo" });
    c.renderer.handle({ type: "assistant.done", text: "hello" });

    expect(c.text()).toBe("hello\n");
  });

  test("a runtime that only sends the finished text is still printed", () => {
    const c = captured();

    c.renderer.handle({ type: "assistant.done", text: "one shot" });

    expect(c.text()).toBe("one shot\n");
  });

  test("escape sequences in model output never reach the terminal", () => {
    const c = captured();

    c.renderer.handle({ type: "assistant.delta", text: "\u001b[31mred\u001b[0m and \u0007bell" });
    c.renderer.handle({ type: "assistant.done", text: "" });

    expect(c.text()).toContain("red");
    expect(c.text()).not.toContain("\u001b");
    expect(c.text()).not.toContain("\u0007");
  });

  test("notice and error lines are one dim/alert line each", () => {
    const c = captured();

    c.renderer.notice("queued \u2014 it goes next");
    c.renderer.error("request failed: boom");

    expect(c.text()).toBe("\u00b7 queued \u2014 it goes next\n\u26a0 request failed: boom\n");
  });
});

describe("compactArgs", () => {
  test("empty arguments render as nothing", () => {
    expect(compactArgs({})).toBe("");
    expect(compactArgs([])).toBe("");
    expect(compactArgs(null)).toBe("");
  });

  test("long arguments are truncated to one short line", () => {
    const compact = compactArgs({ path: "x".repeat(400) });
    expect(compact.length).toBeLessThanOrEqual(120);
    expect(compact.endsWith("\u2026")).toBe(true);
  });

  test("arguments that cannot be serialised are labelled", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(compactArgs(circular)).toBe("[unserialisable]");
  });
});

describe("nested subagent events and turn.diff (S1 P2/P3)", () => {
  const BAR = "\u2502";
  test("child tool cards render indented under the agent card behind a bar", () => {
    const c = captured();
    const wrap = (event: Parameters<typeof c.renderer.handle>[0]) =>
      c.renderer.handle({ type: "subagent.event", agentId: "s1", name: "agent", depth: 1, event });
    wrap({ type: "tool.card", callId: "c", name: "read", args: { path: "a.ts" }, status: "running" });
    wrap({ type: "tool.card", callId: "c", name: "read", args: {}, status: "ok", summary: "12 lines" });
    expect(c.text()).toBe(`  ${BAR} ${CARD} read({"path":"a.ts"})\n  ${BAR}   ${CORNER} ok: 12 lines\n`);
  });

  test("nested output is capped with a marker", () => {
    const c = captured();
    for (let i = 0; i < 60; i++) {
      c.renderer.handle({ type: "subagent.event", agentId: "s2", name: "agent", depth: 1, event: { type: "notice", message: `n${i}` } });
    }
    const lines = c.text().trim().split("\n");
    expect(lines.length).toBe(31);
    expect(lines[30]).toContain("more child output hidden");
  });

  test("turn.diff renders a changed summary and a capped diff", () => {
    const c = captured();
    const diff = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", ...Array.from({ length: 100 }, (_, i) => `+line${i}`)].join("\n");
    c.renderer.handle({ type: "turn.diff", turn: 1, files: 1, diff });
    const text = c.text();
    expect(text.startsWith("\u00b7 changed 1 file\n")).toBe(true);
    expect(text).toContain("  +line0\n");
    expect(text).not.toContain("+line99");
    expect(text).toMatch(/\u2026 \d+ more lines\n$/);
  });

  test("turn.diff with zero files prints nothing", () => {
    const c = captured();
    c.renderer.handle({ type: "turn.diff", turn: 1, files: 0, diff: "" });
    expect(c.text()).toBe("");
  });
});

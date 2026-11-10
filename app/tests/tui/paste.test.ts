import { describe, expect, test } from "bun:test";
import { createPasteCollector, echoedRows, pasteLabel } from "../../src/tui/paste";

describe("bracketed paste", () => {
  test("lines outside a paste are not collected", () => {
    const c = createPasteCollector();
    expect(c.active()).toBe(false);
    expect(c.line("hello")).toBeUndefined();
  });

  test("a multi-line paste becomes one input", () => {
    const c = createPasteCollector();
    expect(c.key("paste-start")).toBe(true);
    expect(c.line("one")).toBeUndefined();
    expect(c.line("two")).toBeUndefined();
    expect(c.key("paste-end")).toBe(true);
    const r = c.line("three");
    expect(r).toEqual({ text: "one\ntwo\nthree", lines: 3, raw: ["one", "two", "three"] });
    expect(c.active()).toBe(false);
  });

  test("a trailing newline does not add a line; a one-line paste stays one line", () => {
    const c = createPasteCollector();
    c.key("paste-start");
    c.line("a");
    c.key("paste-end");
    expect(c.line("")?.lines).toBe(1);
    c.key("paste-start");
    c.key("paste-end");
    expect(c.line("solo")).toEqual({ text: "solo", lines: 1, raw: ["solo"] });
  });

  test("other keys are ignored", () => {
    const c = createPasteCollector();
    expect(c.key("return")).toBe(false);
    expect(c.key(undefined)).toBe(false);
  });

  test("label and echoed rows", () => {
    expect(pasteLabel(12)).toBe("[pasted 12 lines]");
    expect(pasteLabel(1)).toBe("[pasted 1 line]");
    expect(echoedRows(["abcdefghij", "", "x"], 2, 10)).toBe(2 + 1 + 1);
  });
});

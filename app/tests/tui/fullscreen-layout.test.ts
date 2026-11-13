import { describe, expect, test } from "bun:test";
import { diffBuffers, encodeDiffRuns } from "../../src/tui/cellbuffer";
import {
  buildFullscreenFrame,
  buildFullscreenFrameWithInsetPane,
  encodeFullscreenConsecutiveFrameDiff,
  encodeFullscreenFrameDiff,
  fullscreenLayoutRows,
  fullscreenPaintKindSoftTransition,
  fullscreenTranscriptScrollBackMax,
  sliceTranscriptTail,
  sliceTranscriptViewport,
  wrapPlainLine,
} from "../../src/tui/fullscreen-layout";
import {
  buildFullscreenPaletteFrame,
  fullscreenPaletteStateWithQuery,
} from "../../src/tui/fullscreen-palette";
import { buildFullscreenCompletionFrame } from "../../src/tui/fullscreen-completion";
import { applyEditorKey } from "../../src/tui/fullscreen-line-editor";

describe("fullscreen-layout", () => {
  test("layout reserves status and input rows", () => {
    const l = fullscreenLayoutRows(20);
    expect(l.statusRow).toBe(0);
    expect(l.inputRow).toBe(19);
    expect(l.transcriptRows).toBe(18);
  });

  test("wrap and tail keep only the bottom of the transcript", () => {
    const wrapped = wrapPlainLine("abcdef", 4);
    expect(wrapped).toEqual(["abcd", "ef"]);
    const tail = sliceTranscriptTail(["line-one", "line-two-longer"], 6, 2);
    expect(tail.length).toBe(2);
    expect(tail.join("")).toContain("longer");
  });

  test("inset scrollBack shifts viewport without changing tail-only default", () => {
    const lines = ["one", "two", "three", "four", "five"];
    const w = 80;
    const rows = 2;
    const tail = sliceTranscriptTail(lines, w, rows);
    const scrolled = sliceTranscriptViewport(lines, w, rows, fullscreenTranscriptScrollBackMax(lines, w, rows));
    expect(tail.join(" ")).toContain("five");
    expect(scrolled.join(" ")).toContain("one");
  });

  test("inset scrollback pane paint + differential encode (ruling 299, **308** live paint)", () => {
    const a = buildFullscreenFrameWithInsetPane({
      width: 30,
      height: 8,
      status: "idle",
      transcript: ["main line"],
      insetPaneRows: 2,
      insetScrollback: ["scroll one", "scroll two"],
      input: "",
    });
    const b = buildFullscreenFrameWithInsetPane({
      width: 30,
      height: 8,
      status: "idle",
      transcript: ["main line", "new"],
      insetPaneRows: 2,
      insetScrollback: ["scroll one", "scroll two"],
      input: "x",
    });
    const diff = encodeFullscreenFrameDiff(a, b);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain("\u001b[4;1H");
    expect(diff).toContain("x");
    expect(diff).not.toContain("\u001b[2J");
  });

  test("buildFullscreenFrame paints status and input golden", () => {
    const buf = buildFullscreenFrame({
      width: 40,
      height: 5,
      status: "status",
      transcript: ["hello"],
      input: "typing",
    });
    const painted = encodeDiffRuns(diffBuffers(null, buf));
    expect(painted).toContain("status");
    expect(painted).toContain("typing");
    expect(painted).toContain(">");
    expect(painted).toContain("hello");
  });

  test("consecutive overlay paint diffs same kind and size (ruling 310)", () => {
    const base = {
      width: 40,
      height: 8,
      status: "idle",
      transcript: ["main"],
      input: "",
    };
    const a = buildFullscreenFrame(base);
    const b = buildFullscreenFrame({ ...base, input: "a" });
    const crossKind = encodeFullscreenConsecutiveFrameDiff(a, b, "palette", "main");
    expect(crossKind).not.toContain("\u001b[2J");
    expect(fullscreenPaintKindSoftTransition("palette", "main")).toBe(true);

    const overlayCross = encodeFullscreenConsecutiveFrameDiff(a, b, "palette", "picker");
    expect(overlayCross).not.toContain("\u001b[2J");
    expect(fullscreenPaintKindSoftTransition("palette", "picker")).toBe(true);

    const mainDiff = encodeFullscreenConsecutiveFrameDiff(a, b, "main", "main");
    expect(mainDiff).not.toContain("\u001b[2J");
    expect(mainDiff).toContain("a");
  });

  test("overlay opens another overlay with soft transition at same size (ruling 317)", () => {
    const palette = buildFullscreenPaletteFrame({
      width: 50,
      height: 10,
      state: fullscreenPaletteStateWithQuery([], "a"),
    });
    const completion = buildFullscreenCompletionFrame({
      width: 50,
      height: 10,
      state: { token: "/c", hits: ["/copy", "/status"], selectedIndex: 0 },
    });
    const encoded = encodeFullscreenConsecutiveFrameDiff(palette, completion, "palette", "completion");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded).not.toContain("\u001b[2J");
    expect(fullscreenPaintKindSoftTransition("palette", "completion")).toBe(true);
  });

  test("main opens palette overlay with soft transition at same size (ruling 316)", () => {
    const base = {
      width: 50,
      height: 10,
      status: "idle",
      transcript: ["main line"],
      input: "",
    };
    const main = buildFullscreenFrame(base);
    const palette = buildFullscreenPaletteFrame({
      width: 50,
      height: 10,
      state: fullscreenPaletteStateWithQuery([], "cmd"),
    });
    const encoded = encodeFullscreenConsecutiveFrameDiff(main, palette, "main", "palette");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded).not.toContain("\u001b[2J");
  });
});

describe("fullscreen-line-editor", () => {
  test("printable, backspace, enter, ctrl+c", () => {
    let t = "";
    const a = applyEditorKey(t, "x".charCodeAt(0));
    expect(a.text).toBe("x");
    t = a.text;
    const b = applyEditorKey(t, 8);
    expect(b.text).toBe("");
    const c = applyEditorKey("hi", 13);
    expect(c.action).toEqual({ kind: "submit" });
    const d = applyEditorKey("hi", 3);
    expect(d.action).toEqual({ kind: "interrupt" });
  });
});

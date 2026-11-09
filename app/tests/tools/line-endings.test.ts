/**
 * line-endings.test.ts -- the shared LF-view helper (FEAT-001).
 *
 * detectLineEnding is "CRLF if \r\n appears ANYWHERE, else LF" -- including the
 * no-linebreak case. normalizeLineEndings re-joins on either ending. These
 * helpers back the CRLF safety in edit.ts and write.ts; reverting them (e.g.
 * detecting only the first break, or gating on os.EOL) breaks these asserts.
 */

import { describe, expect, test } from "bun:test";
import { detectLineEnding, normalizeLineEndings } from "../../src/tools/line-endings";

describe("detectLineEnding", () => {
  test("pure-LF content is LF", () => {
    expect(detectLineEnding("a\nb\nc\n")).toBe("\n");
  });

  test("pure-CRLF content is CRLF", () => {
    expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });

  test("content with no line break at all is LF", () => {
    expect(detectLineEnding("no breaks here")).toBe("\n");
    expect(detectLineEnding("")).toBe("\n");
  });

  test("a single CRLF anywhere pulls a mostly-LF file to CRLF", () => {
    // The mixed case that matters: a CRLF file with LF-only lines inserted by an
    // earlier tool release. Any surviving \r\n wins.
    expect(detectLineEnding("a\nb\r\nc\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\nc\r\n")).toBe("\r\n");
    expect(detectLineEnding("\r\na\nb")).toBe("\r\n");
  });

  test("a lone CR (no following LF) is NOT treated as CRLF", () => {
    expect(detectLineEnding("a\rb\nc")).toBe("\n");
  });
});

describe("normalizeLineEndings", () => {
  test("pure-LF normalised to LF is byte-identical (the common no-op case)", () => {
    const text = "one\ntwo\nthree\n";
    expect(normalizeLineEndings(text, "\n")).toBe(text);
  });

  test("LF -> CRLF converts every break", () => {
    expect(normalizeLineEndings("a\nb\nc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
  });

  test("CRLF -> LF strips every \\r", () => {
    expect(normalizeLineEndings("a\r\nb\r\nc\r\n", "\n")).toBe("a\nb\nc\n");
  });

  test("mixed endings are unified", () => {
    expect(normalizeLineEndings("a\r\nb\nc\r\n", "\n")).toBe("a\nb\nc\n");
    expect(normalizeLineEndings("a\r\nb\nc\r\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
  });

  test("round-trips LF -> CRLF -> LF", () => {
    const text = "alpha\nbeta\ngamma\n";
    const crlf = normalizeLineEndings(text, "\r\n");
    expect(normalizeLineEndings(crlf, "\n")).toBe(text);
  });

  test("content without a trailing newline keeps its shape", () => {
    expect(normalizeLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
  });
});

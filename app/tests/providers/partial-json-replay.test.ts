/**
 * partial-json-replay.test.ts -- raw→admitted argument binding (plan Task 8).
 * Wraps the existing parser unchanged; no receipt semantics change.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../../src/core/canon";
import { parsePartialJsonWithReplay } from "../../src/core/providers/partial-json-replay";

describe("partial JSON replay digests", () => {
  test("raw and replay digests bind parsed args and detect a changed raw blob", () => {
    const raw = '{"path":"a.txt",}';
    const a = parsePartialJsonWithReplay(raw, "edit");
    expect(a.repaired).toBe(true);
    expect(a.rawDigest).toBe(sha256Hex(raw));
    expect(a.replayArgsDigest).toBe(sha256Hex(canonicalJson(a.args)));
    expect(a.replayArgsDigest).not.toBe(a.rawDigest);
    expect(parsePartialJsonWithReplay('{"path":"b.txt",}', "edit").rawDigest).not.toBe(a.rawDigest);
    expect(parsePartialJsonWithReplay(raw, "edit").rawDigest).toBe(a.rawDigest);
  });

  test("refusals keep the parsed-error text and digest only the raw bytes", () => {
    const raw = "{";
    const result = parsePartialJsonWithReplay(raw, "write");
    expect(result.args).toEqual({});
    expect(typeof result.error).toBe("string");
    expect(result.rawDigest).toBe(sha256Hex(raw));
    expect(result.replayArgsDigest).toBe(sha256Hex(canonicalJson({})));
  });

  test("valid JSON is not marked repaired or truncated", () => {
    const result = parsePartialJsonWithReplay('{"a":1}', "read");
    expect(result.repaired).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.args).toEqual({ a: 1 });
  });
});

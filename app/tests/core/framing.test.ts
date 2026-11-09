/**
 * framing.test.ts — the Content-Length JSON-RPC framer (core/lsp/framing.ts).
 *
 * The contract these tests defend is the one the LSP transport reads off the
 * wire: a decoded sequence of complete message objects, preserved across
 * arbitrary chunk boundaries, with a malformed frame resynced past rather than
 * stalling the stream. If the framer regresses, the client silently stops
 * seeing diagnostics (a split body is never reassembled) or hangs forever (a
 * headerless block is never skipped).
 */

import { describe, expect, test } from "bun:test";
import { encodeMessage, LspFramer } from "../../src/core/lsp/framing";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

describe("lsp framer", () => {
  test("encodeMessage frames by UTF-8 byte length, not character count", () => {
    // A multi-byte character must not under-count the Content-Length, or the
    // peer's reader desynchronises on the next frame.
    const frame = new TextDecoder().decode(encodeMessage({ s: "é€" }));
    const body = JSON.stringify({ s: "é€" });
    const byteLen = encoder.encode(body).length;
    expect(frame).toBe(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    expect(byteLen).toBeGreaterThan(body.length); // proves bytes != chars here
  });

  test("a message split across chunk boundaries reassembles into one object", () => {
    const framer = new LspFramer();
    const whole = new TextDecoder().decode(encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    // Split mid-header AND mid-body across three pushes.
    const a = whole.slice(0, 8);
    const b = whole.slice(8, whole.indexOf("{") + 3);
    const c = whole.slice(whole.indexOf("{") + 3);
    framer.push(bytes(a));
    expect(framer.drain()).toEqual([]); // header incomplete
    framer.push(bytes(b));
    expect(framer.drain()).toEqual([]); // body incomplete
    framer.push(bytes(c));
    expect(framer.drain()).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  test("two messages in one chunk drain as two objects in order", () => {
    const framer = new LspFramer();
    const first = encodeMessage({ id: 1, method: "a" });
    const second = encodeMessage({ id: 2, method: "b" });
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    framer.push(joined);
    expect(framer.drain()).toEqual([
      { id: 1, method: "a" },
      { id: 2, method: "b" },
    ]);
  });

  test("a junk header block with no Content-Length is skipped, and the next valid frame still decodes", () => {
    const notices: string[] = [];
    const framer = new LspFramer((message) => notices.push(message));
    const junk = "X-Nonsense: 1\r\nContent-Type: x\r\n\r\n"; // no Content-Length
    const valid = new TextDecoder().decode(encodeMessage({ id: 7, method: "ok" }));
    framer.push(bytes(junk + valid));
    // The framer resyncs past the junk header and returns ONLY the valid frame.
    expect(framer.drain()).toEqual([{ id: 7, method: "ok" }]);
    expect(notices.some((n) => n.includes("no Content-Length"))).toBe(true);
  });

  test("a frame whose body is not JSON is dropped with a notice, not thrown", () => {
    const notices: string[] = [];
    const framer = new LspFramer((message) => notices.push(message));
    const badBody = "not json at all";
    const frame = `Content-Length: ${encoder.encode(badBody).length}\r\n\r\n${badBody}`;
    const valid = new TextDecoder().decode(encodeMessage({ id: 9, ok: true }));
    framer.push(bytes(frame + valid));
    expect(framer.drain()).toEqual([{ id: 9, ok: true }]);
    expect(notices.some((n) => n.includes("not JSON"))).toBe(true);
  });
});

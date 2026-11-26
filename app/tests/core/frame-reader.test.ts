/**
 * frame-reader.test.ts — cancel-safe length-prefixed frame decoder
 * (grok leader FrameReader ADAPT). Pure: feed chunks, emit complete frames.
 */
import { describe, expect, test } from "bun:test";
import {
  FRAME_HEADER_LEN,
  MAX_FRAME_SIZE,
  createFrameReader,
  encodeFrame,
} from "../../src/core/frame-reader";

describe("cancel-safe frame reader (grok port)", () => {
  test("format constants match upstream", () => {
    expect(FRAME_HEADER_LEN).toBe(4);
    expect(MAX_FRAME_SIZE).toBe(64 * 1024 * 1024);
  });

  test("encodeFrame / decode round-trips a body", () => {
    const r = createFrameReader();
    const frame = encodeFrame("hello");
    expect(r.feed(frame)).toEqual(["hello"]);
  });

  test("split chunks never desynchronize (cancel-safe)", () => {
    const r = createFrameReader();
    const frame = encodeFrame("abcdef");
    expect(r.feed(frame.subarray(0, 2))).toEqual([]); // partial header
    expect(r.feed(frame.subarray(2, 7))).toEqual([]); // rest header + partial body
    expect(r.feed(frame.subarray(7))).toEqual(["abcdef"]);
  });

  test("two frames in one chunk emit in order", () => {
    const r = createFrameReader();
    const chunk = new Uint8Array([...encodeFrame("a"), ...encodeFrame("bc")]);
    expect(r.feed(chunk)).toEqual(["a", "bc"]);
  });

  test("oversized declared length is a typed refusal", () => {
    const r = createFrameReader();
    const hdr = new Uint8Array(4);
    new DataView(hdr.buffer).setUint32(0, MAX_FRAME_SIZE + 1, false);
    expect(() => r.feed(hdr)).toThrow(/large|size/i);
  });

  test("end(false) with an incomplete body is an error; clean EOF is ok", () => {
    const r = createFrameReader();
    const frame = encodeFrame("body");
    r.feed(frame.subarray(0, 6)); // header + 2 bytes
    expect(() => r.end()).toThrow(/eof|incomplete|frame/i);
    const r2 = createFrameReader();
    expect(r2.end()).toEqual([]);
  });
});

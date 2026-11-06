/**
 * sse.test.ts — the shared Server-Sent Events reader.
 *
 * These tests are byte-level: every body is delivered through a chunked
 * ReadableStream and the split points are chosen deliberately (mid-line,
 * mid-frame, between the two newlines of a frame separator, and inside a
 * multi-byte UTF-8 character), because a real proxy will cut anywhere.
 */

import { describe, expect, test } from "bun:test";
import { errorText, isAbortError, readSse, truncate, type SseMessage } from "../../src/core/providers/sse";
import { chunkBody, cutAt, insideByte, sseFrame, splitIsAwkward, streamBody } from "./helpers";

/** Parse a body the way a provider would, at the given chunk boundaries. */
async function messages(text: string, cuts?: number[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of readSse(streamBody(text, { cuts, delays: [] }))) out.push(message);
  return out;
}

const snowman = `data: ${JSON.stringify({ text: "snowman \u2603 here" })}\n\n`;

describe("readSse", () => {
  test("reads the event name and the data payload of every frame", async () => {
    const body =
      sseFrame({ type: "message_start", message: { usage: { input_tokens: 3 } } }, "message_start") +
      sseFrame({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, "content_block_delta") +
      sseFrame("[DONE]");

    expect(await messages(body)).toEqual([
      { event: "message_start", data: '{"type":"message_start","message":{"usage":{"input_tokens":3}}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}' },
      { data: "[DONE]", event: undefined },
    ]);
  });

  test("joins multi-line data with newlines and skips comments and data-less blocks", async () => {
    const body = [
      ": a comment line",
      "",
      "event: note",
      "data: first line",
      "data: second line",
      "",
      "id: 42",
      "retry: 100",
      "",
      "data:no-space-after-the-colon",
      "",
      "data",
      "",
    ].join("\n");

    expect(await messages(body)).toEqual([
      { event: "note", data: "first line\nsecond line" },
      { event: undefined, data: "no-space-after-the-colon" },
      { event: undefined, data: "" },
    ]);
  });

  test("reassembles a frame split across chunks at awkward bytes", async () => {
    const body = sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "snowman \u2603 here" } }, "content_block_delta") + sseFrame("[DONE]");
    const cuts = [
      cutAt(body, "event:", 3), // mid-line, inside the "event:" keyword
      cutAt(body, "data:", 2), // mid-line, inside the "data:" keyword
      cutAt(body, "\n\ndata: [DONE]", 1), // exactly between the two newlines of the separator
      insideByte(body, "\u2603"), // one byte into the 3-byte snowman
      cutAt(body, "\u2603 here", 4), // mid-payload, after the multi-byte character
    ];
    for (const cut of cuts) expect(splitIsAwkward(body, cut)).toBe(true);

    const expected = await messages(body);
    expect(await messages(body, cuts)).toEqual(expected);
    expect(expected).toEqual([
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"snowman \u2603 here"}}' },
      { event: undefined, data: "[DONE]" },
    ]);
  });

  test("is agnostic to every possible split point (one server write per byte)", async () => {
    const body = sseFrame({ type: "text", n: 1 }, "a") + sseFrame({ text: "snowman \u2603", n: 2 }, "b");
    const bytes = chunkBody(body).chunks[0]?.length ?? 0;
    const expected = await messages(body);
    expect(bytes).toBeGreaterThan(40);

    for (let offset = 1; offset < bytes; offset += 1) {
      const split = await messages(body, [offset]);
      if (JSON.stringify(split) !== JSON.stringify(expected)) {
        throw new Error(`split at byte ${offset} changed the parse: ${JSON.stringify(split)}`);
      }
    }
  });

  test("accepts CRLF and bare-CR line endings", async () => {
    const body = "event: a\r\ndata: one\r\n\r\nevent: b\rdata: two\r\rdata: three\r";
    expect(await messages(body)).toEqual([
      { event: "a", data: "one" },
      { event: "b", data: "two" },
      { event: undefined, data: "three" },
    ]);
  });

  test("flushes a trailing frame that never received its blank line", async () => {
    expect(await messages("event: tail\ndata: last frame, no terminator")).toEqual([
      { event: "tail", data: "last frame, no terminator" },
    ]);
  });

  test("an empty body yields nothing", async () => {
    expect(await messages("")).toEqual([]);
  });

  test("propagates a body error instead of hanging", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(sseFrame({ type: "message_start" }, "message_start")));
        await Bun.sleep(5);
        controller.error(new Error("socket reset by peer"));
      },
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const message of readSse(body)) seen.push(message.event ?? "");
      })(),
    ).rejects.toThrow("socket reset by peer");
    expect(seen).toEqual(["message_start"]);
  });

  test("survives a body whose stream is cancelled by the consumer", async () => {
    const body = streamBody(sseFrame({ a: 1 }, "a") + sseFrame({ b: 2 }, "b"), { delays: [20, 20] });
    const iterator = readSse(body)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ event: "a", data: '{"a":1}' });
    await iterator.return?.(undefined);
    // the reader lock must be released so nothing throws on the way out
    expect(body.locked).toBe(false);
  });
});

describe("sse helpers", () => {
  test("errorText renders non-errors without throwing", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain string")).toBe("plain string");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText({ name: "Weird", message: "nope" })).toBe("[object Object]");
  });

  test("isAbortError recognises aborts, timeouts and an already-aborted signal", () => {
    const controller = new AbortController();
    expect(isAbortError(new Error("x"), controller.signal)).toBe(false);
    controller.abort();
    expect(isAbortError(new Error("x"), controller.signal)).toBe(true);
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isAbortError(aborted)).toBe(true);
    expect(isAbortError(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(true);
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  test("truncate ellipsises long values and passes short ones through", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 3)).toBe("abc\u2026");
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate(undefined as unknown as string, 3)).toBe("");
  });
});

/** The split helpers are what make the provider tests byte-level, so test them too. */
describe("test harness chunking", () => {
  test("chunkBody cuts exactly at the requested byte offsets", () => {
    const { chunks, starts } = chunkBody("abcdefghij", [3, 7]);
    expect(starts).toEqual([0, 3, 7, 10]);
    expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["abc", "defg", "hij"]);
  });

  test("chunkBody ignores duplicates, out-of-range offsets and keeps multi-byte characters intact", () => {
    const { chunks, starts } = chunkBody("a\u2603b", [1, 1, 4, 99, -1]);
    expect(starts).toEqual([0, 1, 4, 5]);
    expect(new TextDecoder().decode(chunks[1]!)).toBe("\u2603");
  });

  test("cutAt and splitIsAwkward distinguish clean frame boundaries", () => {
    const body = sseFrame({ a: 1 }, "one") + sseFrame({ b: 2 }, "two");
    const boundary = cutAt(body, "\n\nevent: two") + 2;
    expect(splitIsAwkward(body, boundary)).toBe(false);
    expect(splitIsAwkward(body, cutAt(body, "event: two", 3))).toBe(true);
    expect(() => cutAt(body, "not-in-the-body")).toThrow(/not found/);
  });
});

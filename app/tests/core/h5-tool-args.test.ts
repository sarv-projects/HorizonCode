/**
 * H-5 (ruling 495 + this slice): adapter-local JSON shape repair lives in
 * tiny single-purpose utils, never inline in a message / SSE / NDJSON loop.
 * Every adapter stays fail-closed for malformed / truncated tool arguments and
 * never throws at the caller. Anthropic is intentionally not touched here.
 */

import { describe, expect, test } from "bun:test";
import { parseJsonObject } from "../../src/core/json-repair";
import { createGoogleProvider } from "../../src/core/providers/google";
import { createOllamaProvider } from "../../src/core/providers/ollama";
import {
  isCompleteToolArgsObject,
  toolArgsJson,
  toolArgsObject,
} from "../../src/core/providers/tool-args-object";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import { makeRequest, run, sseFrame, sseResponse, toolCallsOf, withServer } from "../providers/helpers";

const encoder = new TextEncoder();

/* --------------------------- local offline wire helpers -------------------------- */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function stubFetch(body: string, headers: Record<string, string>): { fetch: FetchLike; bodies: unknown[] } {
  const bodies: unknown[] = [];
  return {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
          },
        }),
        { headers },
      );
    },
    bodies,
  };
}

function geminiFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function ollamaLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

/* --------------------------------- utils --------------------------------- */

describe("H-5 single-purpose JSON utils", () => {
  test("parseJsonObject is strict, object-only and never throws", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("{broken")).toBeUndefined();
    expect(parseJsonObject("[1,2]")).toBeUndefined();
    expect(parseJsonObject('"text"')).toBeUndefined();
  });

  test("isCompleteToolArgsObject detects a complete object without looping", () => {
    expect(isCompleteToolArgsObject('{"path":')).toBe(false);
    expect(isCompleteToolArgsObject('{"path":"a.ts"}')).toBe(true);
    expect(isCompleteToolArgsObject("")).toBe(false);
    expect(isCompleteToolArgsObject("null")).toBe(false);
  });

  test("toolArgsJson normalizes object / string / malformed shapes, fail-closed", () => {
    expect(toolArgsJson({ path: "a.ts" })).toBe('{"path":"a.ts"}');
    expect(toolArgsJson('{"path":"a.ts"}')).toBe('{"path":"a.ts"}');
    expect(toolArgsJson('{"path":')).toBe("{}");
    expect(toolArgsJson(undefined)).toBe("{}");
    expect(toolArgsObject('{"path":')).toEqual({});
  });
});

/* --------------------------------- google --------------------------------- */

describe("H-5 google tool args through utils", () => {
  test("a valid object arg stays byte-identical", async () => {
    const frame = geminiFrame({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "read", args: { path: "a.ts" } } }] },
          finishReason: "STOP",
        },
      ],
    });
    const { fetch: stub } = stubFetch(frame, { "content-type": "text/event-stream" });
    const result = run(
      createGoogleProvider({ apiKey: "k", baseUrl: "https://gemini.example", fetch: stub }),
      makeRequest(),
    );
    await result.done;
    expect(result.thrown).toBeNull();
    expect(toolCallsOf(result.events)[0]!.arguments).toBe('{"path":"a.ts"}');
  });

  test("a malformed / truncated arg string fails closed to {} instead of throwing", async () => {
    const frame = geminiFrame({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "read", args: '{"path":' } }] },
          finishReason: "STOP",
        },
      ],
    });
    const { fetch: stub } = stubFetch(frame, { "content-type": "text/event-stream" });
    const result = run(
      createGoogleProvider({ apiKey: "k", baseUrl: "https://gemini.example", fetch: stub }),
      makeRequest(),
    );
    await result.done;
    expect(result.thrown).toBeNull();
    expect(toolCallsOf(result.events)[0]!.arguments).toBe("{}");
  });
});

/* --------------------------------- ollama --------------------------------- */

describe("H-5 ollama tool args through utils", () => {
  test("streamed fragments that form a valid object still emit the full args", async () => {
    const body =
      ollamaLine({ message: { tool_calls: [{ function: { name: "glob", arguments: '{"pat' } }] } }) +
      ollamaLine({ message: { tool_calls: [{ function: { name: "glob", arguments: 'tern":"*.ts"}' } }] } }) +
      ollamaLine({ message: {}, done: true });
    const { fetch: stub } = stubFetch(body, { "content-type": "application/x-ndjson" });
    const result = run(createOllamaProvider({ baseUrl: "http://127.0.0.1:11434", fetch: stub }), makeRequest());
    await result.done;
    expect(result.thrown).toBeNull();
    expect(toolCallsOf(result.events)[0]!.arguments).toBe('{"pattern":"*.ts"}');
  });

  test("a truncated arg tail fails closed to {} (never a half-sent command)", async () => {
    const body =
      ollamaLine({ message: { tool_calls: [{ function: { name: "shell", arguments: '{"command":"rm -' } }] } }) +
      ollamaLine({ message: {}, done: true });
    const { fetch: stub } = stubFetch(body, { "content-type": "application/x-ndjson" });
    const result = run(createOllamaProvider({ baseUrl: "http://127.0.0.1:11434", fetch: stub }), makeRequest());
    await result.done;
    expect(result.thrown).toBeNull();
    expect(toolCallsOf(result.events)[0]!.arguments).toBe("{}");
  });
});

/* --------------------------------- openai --------------------------------- */

describe("H-5 openai malformed frames are skipped, valid tool args pass through", () => {
  test("a malformed frame carrying a tool-call delta is skipped; the next valid call survives", async () => {
    const body =
      sseFrame('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{bad"') +
      sseFrame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      sseFrame("[DONE]");
    await withServer(
      () => sseResponse(body),
      async (server) => {
        const result = run(
          createOpenAiProvider({ apiKey: "k", baseUrl: server.baseUrl }),
          makeRequest(),
        );
        await result.done;
        expect(result.thrown).toBeNull();
        const calls = toolCallsOf(result.events);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.arguments).toBe('{"path":"a.ts"}');
      },
    );
  });
});

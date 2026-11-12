/**
 * providers-expansion.test.ts — the google (Gemini) and ollama adapters, plus
 * the config surface they need.
 *
 * No network: both providers take an injected transport, and every test answers
 * with a scripted Response whose body is a ReadableStream the test controls —
 * including a body that stays open until the abort signal fires and one that
 * fails on the read after its first chunk, like a dropped socket. That injected
 * `fetch` setting is additive; production defaults to the global fetch.
 *
 * The assertion helpers (run, textOf, toolCallsOf, lastDone, makeRequest) are
 * the providers/ suite's own, so this file stubs only the wire.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { HzConfig } from "../../src/core/config";
import { DEFAULT_MODELS, describeConfig, loadConfig, missingKey, PROVIDER_NAMES } from "../../src/core/config";
import { makeProvider } from "../../src/core/providers";
import { createGoogleProvider } from "../../src/core/providers/google";
import { createOllamaProvider } from "../../src/core/providers/ollama";
import type { Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../src/contracts";
import { lastDone, makeRequest, parseJson, run, textOf, toolCallsOf, waitFor } from "../providers/helpers";
import { cleanupTemps, tempDir } from "./helpers";

const encoder = new TextEncoder();
const GOOGLE_BASE = "https://gemini.example";
const OLLAMA_BASE = "http://127.0.0.1:11434";

/* ------------------------------ the stub wire ------------------------------ */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type StubHandler = (call: StubCall, index: number) => Response | Promise<Response>;

/** An offline transport: records each request and answers from `handler`. */
function stubFetch(handler: StubHandler): { fetch: FetchLike; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers as Record<string, string> | undefined) ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    const call: StubCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return await handler(call, calls.length - 1);
  };
  return { fetch: fetchImpl, calls };
}

/** A body that writes every part, then closes. */
function closedBody(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/**
 * A body that writes its parts, then stays open until `signal` aborts — the
 * way a real fetch errors the stream when the request is cancelled.
 */
function heldBody(parts: string[], signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      const abort = (): void => {
        try {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          /* the stream is already closed */
        }
      };
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    },
  });
}

/**
 * A body that delivers its parts on the first read, then fails on the next —
 * a dropped socket after output began.
 */
function droppedBody(parts: string[]): ReadableStream<Uint8Array> {
  let reads = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads === 0) {
        reads += 1;
        for (const part of parts) controller.enqueue(encoder.encode(part));
        if (parts.length > 0) return;
      }
      controller.error(new TypeError("The socket connection was closed unexpectedly."));
    },
  });
}

/** An SSE response over a closed body. */
function sseResponse(parts: string[]): Response {
  return new Response(closedBody(parts), { headers: { "content-type": "text/event-stream" } });
}

/** An NDJSON response over a closed body. */
function ndjsonResponse(parts: string[]): Response {
  return new Response(closedBody(parts), { headers: { "content-type": "application/x-ndjson" } });
}

/** One Gemini SSE frame. */
function geminiFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One ollama NDJSON line. */
function ollamaLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

/** Two attempts with a 1 ms backoff, so the retry paths stay fast. */
const STUB_RETRY = { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

/* ------------------------------- assertions ------------------------------- */

async function collect(provider: Provider, req: ProviderRequest = makeRequest()): Promise<ProviderEvent[]> {
  const result = run(provider, req);
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

function errorsOf(events: ProviderEvent[]): Array<Extract<ProviderEvent, { type: "error" }>> {
  return events.filter((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
}

function noticesOf(events: ProviderEvent[]): string[] {
  return events
    .filter((event): event is Extract<ProviderEvent, { type: "notice" }> => event.type === "notice")
    .map((event) => event.message);
}

/* --------------------------------- google --------------------------------- */

describe("google (Gemini) provider", () => {
  test("streams text and usage, and POSTs the v1beta SSE endpoint", async () => {
    const frames = [
      geminiFrame({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Checking " }] } }] }),
      // Split a data line mid-JSON: the reader must join the chunks again.
      'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"te',
      'xt":"both files."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4,"totalTokenCount":15}}\n\n',
    ];
    const { fetch: stub, calls } = stubFetch(() => sseResponse(frames));

    const events = await collect(createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub }));

    expect(events).toEqual([
      { type: "text", text: "Checking " },
      { type: "text", text: "both files." },
      { type: "done", stopReason: "end", usage: { inputTokens: 11, outputTokens: 4 } },
    ]);
    expect(textOf(events)).toBe("Checking both files.");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${GOOGLE_BASE}/v1beta/models/hz-test-model:streamGenerateContent?alt=sse`);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("gk-test");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    // No system prompt, tools or cap in this request: nothing invented.
    expect(calls[0]!.body).toEqual({ contents: [{ role: "user", parts: [{ text: "hello" }] }] });
  });

  test("maps system, contents, tools and tool results, and emits function calls", async () => {
    const tools: ToolSpec[] = [
      { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ];
    const frames = [
      geminiFrame({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Reading it." }] } }] }),
      geminiFrame({
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "read", args: { path: "a.ts" } } },
                { functionCall: { id: "fc_glob", name: "glob", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 9 },
      }),
    ];
    const { fetch: stub, calls } = stubFetch(() => sseResponse(frames));

    const events = await collect(
      createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub }),
      makeRequest({
        system: "be brief",
        maxTokens: 64,
        tools,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "reading", toolCalls: [{ id: "g1", name: "read", arguments: '{"path":"a.ts"}' }] },
          { role: "tool", content: "file body", toolCallId: "g1", toolName: "read" },
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["text", "tool_call", "tool_call", "done"]);
    const out = toolCallsOf(events);
    // No id on the wire -> synthesized call_<n>; an id that is there passes through.
    expect(out.map((call) => [call.id, call.name])).toEqual([
      ["call_1", "read"],
      ["fc_glob", "glob"],
    ]);
    expect(parseJson(out[0]!.arguments)).toEqual({ path: "a.ts" });
    expect(out[1]!.arguments).toBe("{}");
    expect(lastDone(events)).toEqual({ type: "done", stopReason: "tool_use", usage: { inputTokens: 42, outputTokens: 9 } });

    expect(calls[0]!.body).toEqual({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "reading" }, { functionCall: { name: "read", args: { path: "a.ts" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "read", response: { result: "file body" } } }] },
      ],
      systemInstruction: { parts: [{ text: "be brief" }] },
      tools: [{ functionDeclarations: [{ name: "read", description: "read a file", parameters: tools[0]!.parameters }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
  });

  test("HTTP 429 retries with a notice, then yields one typed error", async () => {
    const { fetch: stub, calls } = stubFetch(() => new Response("rate limited", { status: 429 }));

    const events = await collect(createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub, retry: STUB_RETRY }));

    expect(calls).toHaveLength(2); // attempts: 2
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("429");
    expect(notices[0]).toContain("retrying");
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(events[events.length - 1]).toBe(errors[0]);
    expect(errors[0]!.message).toContain("google HTTP 429");
    expect(errors[0]!.message).toContain("rate limited");
  });

  test("a malformed frame is skipped with a notice and the stream continues", async () => {
    const frames = [
      "data: {this is not json\n\n",
      geminiFrame({ candidates: [{ index: 0, content: { parts: [{ text: "still here" }] }, finishReason: "STOP" }] }),
    ];
    const { fetch: stub } = stubFetch(() => sseResponse(frames));

    const events = await collect(createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub }));

    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toContain("malformed");
    expect(textOf(events)).toBe("still here");
    expect(lastDone(events).stopReason).toBe("end");
  });

  test("an abort mid-stream ends with done/abort and no second attempt", async () => {
    const controller = new AbortController();
    const frame = geminiFrame({ candidates: [{ index: 0, content: { parts: [{ text: "Hel" }] } }] });
    const { fetch: stub, calls } = stubFetch(() => new Response(heldBody([frame], controller.signal), { headers: { "content-type": "text/event-stream" } }));

    const result = run(createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub }), makeRequest({ signal: controller.signal }));
    await waitFor(() => result.events.length > 0);
    controller.abort();
    await result.done;

    expect(result.thrown).toBeNull();
    expect(result.events).toEqual([{ type: "text", text: "Hel" }, { type: "done", stopReason: "abort" }]);
    expect(calls).toHaveLength(1);
  });

  test("an already-aborted signal never reaches the transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch: stub, calls } = stubFetch(() => sseResponse([]));

    const events = await collect(
      createGoogleProvider({ apiKey: "gk-test", baseUrl: GOOGLE_BASE, fetch: stub }),
      makeRequest({ signal: controller.signal }),
    );

    expect(events).toEqual([{ type: "done", stopReason: "abort" }]);
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------- ollama --------------------------------- */

describe("ollama provider", () => {
  test("streams NDJSON text and final-line usage through /api/chat", async () => {
    const firstLine = ollamaLine({ model: "llama3.1", message: { role: "assistant", content: "Hello " }, done: false });
    const cut = firstLine.indexOf("content") + 3;
    const parts = [
      // Split a line mid-token: the NDJSON reader joins chunks again.
      firstLine.slice(0, cut),
      firstLine.slice(cut),
      ollamaLine({ model: "llama3.1", message: { role: "assistant", content: "world" }, done: false }),
      ollamaLine({ model: "llama3.1", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 17, eval_count: 6 }),
    ];
    const { fetch: stub, calls } = stubFetch(() => ndjsonResponse(parts));

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }));

    expect(events).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
      { type: "done", stopReason: "end", usage: { inputTokens: 17, outputTokens: 6 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${OLLAMA_BASE}/api/chat`);
    expect(calls[0]!.headers["authorization"]).toBeUndefined(); // a local server needs no key
    expect(calls[0]!.body).toEqual({ model: "hz-test-model", messages: [{ role: "user", content: "hello" }], stream: true });
  });

  test("assembles tool_call deltas, including string fragments, and sends tools", async () => {
    const tools: ToolSpec[] = [{ name: "read", description: "read a file", parameters: { type: "object" } }];
    const parts = [
      ollamaLine({ message: { role: "assistant", content: "Reading " } }),
      ollamaLine({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "a.ts" } } }] }, done: false }),
      // a second call whose arguments stream as string fragments
      ollamaLine({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "glob", arguments: '{"pat' } }] }, done: false }),
      ollamaLine({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "glob", arguments: 'tern":"*.ts"}' } }] }, done: false }),
      ollamaLine({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 3 }),
    ];
    const { fetch: stub, calls } = stubFetch(() => ndjsonResponse(parts));

    const events = await collect(
      createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }),
      makeRequest({
        system: "be brief",
        maxTokens: 128,
        tools,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "reading", toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"a.ts"}' }] },
          { role: "tool", content: "file body", toolCallId: "call_1", toolName: "read" },
        ],
      }),
    );

    const out = toolCallsOf(events);
    expect(out.map((call) => [call.id, call.name])).toEqual([
      ["call_1", "read"],
      ["call_2", "glob"],
    ]);
    expect(parseJson(out[0]!.arguments)).toEqual({ path: "a.ts" });
    expect(parseJson(out[1]!.arguments)).toEqual({ pattern: "*.ts" });
    expect(lastDone(events)).toEqual({ type: "done", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 3 } });

    expect(calls[0]!.body).toEqual({
      model: "hz-test-model",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "reading", tool_calls: [{ function: { name: "read", arguments: { path: "a.ts" } } }] },
        { role: "tool", content: "file body", tool_name: "read" },
      ],
      stream: true,
      tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }],
      options: { num_predict: 128 },
    });
  });

  test("HTTP 429 retries with a notice, then yields one typed error", async () => {
    const { fetch: stub, calls } = stubFetch(() => new Response("overloaded", { status: 429 }));

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub, retry: STUB_RETRY }));

    expect(calls).toHaveLength(2);
    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toContain("429");
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("ollama HTTP 429");
    expect(errors[0]!.message).toContain("overloaded");
  });

  test("a malformed line is skipped with a notice and the stream continues", async () => {
    const parts = [
      "this is not a json line\n",
      ollamaLine({ message: { role: "assistant", content: "still here" } }),
      ollamaLine({ message: { role: "assistant", content: "" }, done: true }),
    ];
    const { fetch: stub } = stubFetch(() => ndjsonResponse(parts));

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }));

    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toContain("malformed");
    expect(textOf(events)).toBe("still here");
    expect(lastDone(events).stopReason).toBe("end");
  });

  test("an abort mid-stream ends with done/abort and no re-request", async () => {
    const controller = new AbortController();
    const head = ollamaLine({ message: { role: "assistant", content: "Hel" } });
    const { fetch: stub, calls } = stubFetch(
      () => new Response(heldBody([head], controller.signal), { headers: { "content-type": "application/x-ndjson" } }),
    );

    const result = run(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }), makeRequest({ signal: controller.signal }));
    await waitFor(() => result.events.length > 0);
    controller.abort();
    await result.done;

    expect(result.thrown).toBeNull();
    expect(result.events).toEqual([{ type: "text", text: "Hel" }, { type: "done", stopReason: "abort" }]);
    expect(calls).toHaveLength(1);
  });

  test("a refused connection is one typed error naming the base URL, never a retry storm", async () => {
    const { fetch: stub, calls } = stubFetch(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }));

    expect(calls).toHaveLength(1); // the default policy would retry 4 times; a local server must not
    expect(events).toHaveLength(1);
    const error = errorsOf(events)[0]!;
    expect(error.message).toContain("ollama request failed");
    expect(error.message).toContain(OLLAMA_BASE);
    expect(error.message).toContain("is ollama running?");
  });

  test("a mid-stream drop is re-requested once, then the second drop fails typed", async () => {
    let call = 0;
    const { fetch: stub, calls } = stubFetch(() => {
      call += 1;
      // The first pass dies after one text line; the second dies before any.
      const parts = call === 1 ? [ollamaLine({ message: { role: "assistant", content: "Hel" } })] : [];
      return new Response(droppedBody(parts), { headers: { "content-type": "application/x-ndjson" } });
    });

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }));

    expect(calls).toHaveLength(2); // exactly one re-request
    expect(textOf(events)).toBe("Hel"); // output from the first pass survives
    expect(noticesOf(events).some((message) => message.includes("re-requesting once"))).toBe(true);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("ollama stream failed");
  });

  test("a dropped pass is re-requested and the successful pass completes (earlier text may repeat)", async () => {
    const full = [
      ollamaLine({ message: { role: "assistant", content: "Hel" } }),
      ollamaLine({ message: { role: "assistant", content: "lo" } }),
      ollamaLine({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 2, eval_count: 1 }),
    ];
    let call = 0;
    const { fetch: stub, calls } = stubFetch(() => {
      call += 1;
      if (call === 1) return new Response(droppedBody([ollamaLine({ message: { role: "assistant", content: "Hel" } })]), { headers: { "content-type": "application/x-ndjson" } });
      return new Response(closedBody(full), { headers: { "content-type": "application/x-ndjson" } });
    });

    const events = await collect(createOllamaProvider({ baseUrl: OLLAMA_BASE, fetch: stub }));

    expect(calls).toHaveLength(2);
    // The first pass's "Hel" is not retracted: the re-request replays from the
    // start, so the result is "Hel" + "Hello" (the notice names the repetition).
    expect(textOf(events)).toBe("HelHello");
    expect(noticesOf(events).some((message) => message.includes("re-requesting once"))).toBe(true);
    expect(lastDone(events)).toEqual({ type: "done", stopReason: "end", usage: { inputTokens: 2, outputTokens: 1 } });
  });
});

/* ----------------------------- config + factory ----------------------------- */

describe("config and factory", () => {
  /** A config path inside a fresh temp dir: no file exists there. */
  const missingConfig = (): string => path.join(tempDir("hz-providers-expansion-"), "config.json");

  function configFor(overrides: Partial<HzConfig> = {}): HzConfig {
    return {
      provider: "mock",
      model: "mock-1",
      sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
      ...overrides,
    };
  }

  test("google and ollama are provider names with their own defaults", () => {
    expect([...PROVIDER_NAMES]).toEqual(["anthropic", "openai", "google", "ollama", "mock"]);
    expect(DEFAULT_MODELS.google).toBe("gemini-2.5-flash");
    expect(DEFAULT_MODELS.ollama).toBe("llama3.1");

    const google = loadConfig({ HZ_PROVIDER: "google" }, missingConfig());
    expect(google.provider).toBe("google");
    expect(google.model).toBe("gemini-2.5-flash");
    expect(google.baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(google.apiKey).toBeUndefined();
    expect(google.sources).toEqual({ provider: "env", model: "default", baseUrl: "default", apiKey: "none" });
    expect(missingKey(google)).toBe("GEMINI_API_KEY");
    expect(describeConfig(google)).toBe("google \u00b7 gemini-2.5-flash");

    // Case is normalized like the existing names; the local provider needs no key.
    const ollama = loadConfig({ HZ_PROVIDER: "OLLAMA" }, missingConfig());
    expect(ollama.provider).toBe("ollama");
    expect(ollama.model).toBe("llama3.1");
    expect(ollama.baseUrl).toBe("http://127.0.0.1:11434");
    expect(missingKey(ollama)).toBeNull();
    expect(describeConfig(ollama)).toBe("ollama \u00b7 llama3.1");
  });

  test("google takes GEMINI_API_KEY or GOOGLE_API_KEY, and either one detects the provider", () => {
    const gemini = loadConfig({ HZ_PROVIDER: "google", GEMINI_API_KEY: "gk-1" }, missingConfig());
    expect(gemini.apiKey).toBe("gk-1");
    expect(gemini.sources.apiKey).toBe("env");
    expect(missingKey(gemini)).toBeNull();

    const goog = loadConfig({ HZ_PROVIDER: "google", GOOGLE_API_KEY: "gk-2" }, missingConfig());
    expect(goog.apiKey).toBe("gk-2");

    // A provider key in the environment is a detection, never an override (the
    // same rule ANTHROPIC_API_KEY and OPENAI_API_KEY already follow).
    const detected = loadConfig({ GEMINI_API_KEY: "gk-3" }, missingConfig());
    expect(detected.provider).toBe("google");
    expect(detected.sources.provider).toBe("detected");
    expect(detected.model).toBe(DEFAULT_MODELS.google);
    expect(detected.apiKey).toBe("gk-3");
  });

  test("HZ_BASE_URL overrides the local default and HZ_API_KEY is a proxy key for ollama", () => {
    const proxied = loadConfig(
      { HZ_PROVIDER: "ollama", HZ_BASE_URL: "http://192.168.1.4:11434/remote", HZ_API_KEY: "proxy-key" },
      missingConfig(),
    );
    expect(proxied.baseUrl).toBe("http://192.168.1.4:11434/remote");
    expect(proxied.sources.baseUrl).toBe("env");
    expect(proxied.apiKey).toBe("proxy-key");
    expect(missingKey(proxied)).toBeNull();
  });

  test("an unknown provider name passes through for openai-compatible adapter", () => {
    expect(loadConfig({ HZ_PROVIDER: "prism" }, missingConfig()).provider).toBe("prism");
  });

  test("makeProvider: ollama needs no key; google without one explains both variables", async () => {
    const ollama = makeProvider(loadConfig({ HZ_PROVIDER: "ollama" }, missingConfig()));
    expect(ollama.name).toBe("ollama");

    const google = makeProvider(configFor({ provider: "google", model: "gemini-2.5-flash" }));
    expect(google.name).toBe("google");
    const events = await collect(google);
    expect(events).toHaveLength(2);
    const error = errorsOf(events)[0]!;
    expect(error.message).toContain("No API key for google");
    expect(error.message).toContain("GEMINI_API_KEY");
    expect(error.message).toContain("GOOGLE_API_KEY");
    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });
});

afterAll(() => {
  cleanupTemps();
});

/**
 * openai.test.ts — the OpenAI chat-completions provider.
 *
 * The canned local server replays `data: {...}` chunks cut at deliberate byte
 * offsets, so both the text path and the index-keyed tool-call assembly are
 * exercised across chunk boundaries.
 */

import { describe, expect, test } from "bun:test";
import { createOpenAiProvider, toOpenAiMessages, toOpenAiTools } from "../../src/core/providers/openai";
import type { ProviderEvent, ToolSpec } from "../../src/contracts";
import {
  cutAt,
  deferred,
  insideByte,
  jsonResponse,
  lastDone,
  makeRequest,
  parseJson,
  run,
  sseFrame,
  sseResponse,
  splitIsAwkward,
  startServer,
  textOf,
  toolCallsOf,
  waitFor,
  withServer,
  type CannedServer,
} from "./helpers";

const SNOWMAN = "\u2603";
const FULL_TEXT = `Checking both files ${SNOWMAN}.`;

type OpenAiProvider = ReturnType<typeof createOpenAiProvider>;

function providerFor(server: CannedServer, extra: { maxTokens?: number; baseUrl?: string } = {}): OpenAiProvider {
  return createOpenAiProvider({ apiKey: "sk-oai-test", baseUrl: extra.baseUrl ?? server.baseUrl, maxTokens: extra.maxTokens });
}

/** One chunk of an OpenAI stream. */
function chunk(choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}): string {
  return sseFrame({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: choice ? [choice] : [], ...extra });
}

function asError(event: ProviderEvent | undefined): Extract<ProviderEvent, { type: "error" }> {
  if (!event || event.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(event)}`);
  return event;
}

async function collect(
  provider: OpenAiProvider,
  req = makeRequest(),
): Promise<{ events: ProviderEvent[]; thrown: unknown; elapsedMs: number }> {
  const result = run(provider, req);
  await result.done;
  return { events: result.events, thrown: result.thrown, elapsedMs: result.elapsedMs };
}

describe("openai text streaming", () => {
  test("translates choices[0].delta.content in order, then done/end, and reassembles the text", async () => {
    const body =
      chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }) +
      chunk({ index: 0, delta: { content: "Checking " }, finish_reason: null }) +
      chunk({ index: 0, delta: { content: `both files ${SNOWMAN}.` }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "stop" }) +
      sseFrame({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 21, completion_tokens: 13 } }) +
      sseFrame("[DONE]");

    const cuts = [
      cutAt(body, "data:", 2), // mid-line, inside "data:"
      cutAt(body, "\n\ndata:", 1), // exactly between the two newlines of a separator
      insideByte(body, SNOWMAN), // one byte into the 3-byte snowman
      cutAt(body, "[DONE]", 3), // inside the sentinel frame
    ];
    expect(cuts).toHaveLength(4);
    for (const cut of cuts) expect(splitIsAwkward(body, cut)).toBe(true);

    await withServer(
      () => sseResponse(body, { cuts }),
      async (server) => {
        const result = await collect(providerFor(server));

        expect(result.thrown).toBeNull();
        expect(result.events).toEqual([
          { type: "text", text: "Checking " },
          { type: "text", text: `both files ${SNOWMAN}.` },
          { type: "done", stopReason: "end", usage: { inputTokens: 21, outputTokens: 13 } },
        ]);
        expect(textOf(result.events)).toBe(FULL_TEXT);
        expect(server.requests).toHaveLength(1);
      },
    );
  });

  test("ignores unparsable frames and empty deltas", async () => {
    const body =
      sseFrame('{"choices": [broken') +
      chunk({ index: 0, delta: { content: null }, finish_reason: null }) +
      sseFrame('"just a string"') +
      chunk({ index: 0, delta: { content: "kept" }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "stop" }) +
      sseFrame("[DONE]");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.events).toEqual([{ type: "text", text: "kept" }, { type: "done", stopReason: "end" }]);
      expect(lastDone(result.events).usage).toBeUndefined();
    });
  });

  test("maps finish_reason length to done/max_tokens", async () => {
    const body =
      chunk({ index: 0, delta: { content: "cut off" }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "length" });

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(lastDone(result.events)).toEqual({ type: "done", stopReason: "max_tokens" });
    });
  });
});

describe("openai tool calls", () => {
  test("assembles TWO parallel calls from interleaved index-keyed fragments", async () => {
    const argsA = '{"path": "src/core/loop.ts", "limit": 2}';
    const argsB = '{"pattern": "**/*.ts"}';
    const fragmentsA = ['{"pa', 'th": "src/', 'core/loop.ts", "lim', 'it": 2}'];
    const fragmentsB = ['{"pat', 'tern": "**/*.ts"}'];
    expect(fragmentsA.join("")).toBe(argsA);
    expect(fragmentsB.join("")).toBe(argsB);

    const toolFrame = (fragment: Record<string, unknown>): string =>
      chunk({ index: 0, delta: { tool_calls: [fragment] }, finish_reason: null });

    const body =
      chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }) +
      chunk({ index: 0, delta: { content: `Checking both files ${SNOWMAN}.` }, finish_reason: null }) +
      toolFrame({ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }) +
      toolFrame({ index: 1, id: "call_b", type: "function", function: { name: "glob", arguments: "" } }) +
      fragmentsA.map((piece) => toolFrame({ index: 0, function: { arguments: piece } })).join("") +
      fragmentsB.map((piece) => toolFrame({ index: 1, function: { arguments: piece } })).join("") +
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }) +
      sseFrame({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 40, completion_tokens: 11 } }) +
      sseFrame("[DONE]");

    const cuts = [
      insideByte(body, SNOWMAN),
      cutAt(body, "tool_calls", 5),
      cutAt(body, "loop.ts", 2),
      cutAt(body, "[DONE]", 4),
    ];
    for (const cut of cuts) expect(splitIsAwkward(body, cut)).toBe(true);

    await withServer(
      () => sseResponse(body, { cuts }),
      async (server) => {
        const result = await collect(providerFor(server));
        expect(result.thrown).toBeNull();
        expect(result.events.map((event) => event.type)).toEqual(["text", "tool_call", "tool_call", "done"]);
        expect(textOf(result.events)).toBe(FULL_TEXT);

        const calls = toolCallsOf(result.events);
        expect(calls.map((call) => [call.id, call.name])).toEqual([
          ["call_a", "read"],
          ["call_b", "glob"],
        ]);
        expect(parseJson(calls[0]!.arguments)).toEqual({ path: "src/core/loop.ts", limit: 2 });
        expect(parseJson(calls[1]!.arguments)).toEqual({ pattern: "**/*.ts" });
        expect(lastDone(result.events)).toEqual({ type: "done", stopReason: "tool_use", usage: { inputTokens: 40, outputTokens: 11 } });
      },
    );
  });

  test("synthesises an id when the server never sends one", async () => {
    const body =
      chunk({ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "shell", arguments: '{"command":"ls"}' } }] }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      const calls = toolCallsOf(result.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.id).toBe("call_1");
      expect(parseJson(calls[0]!.arguments)).toEqual({ command: "ls" });
    });
  });

  test("a tool call with no argument fragments reports {} rather than an empty string", async () => {
    const body =
      chunk({ index: 0, delta: { tool_calls: [{ index: 0, id: "call_todo", function: { name: "todo" } }] }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      const calls = toolCallsOf(result.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.arguments).toBe("{}");
      expect(parseJson(calls[0]!.arguments)).toEqual({});
      expect(lastDone(result.events).stopReason).toBe("tool_use");
    });
  });

  test("a fragment without a name is not emitted as a tool call", async () => {
    const body =
      chunk({ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", function: { arguments: "{}" } }] }, finish_reason: null }) +
      chunk({ index: 0, delta: {}, finish_reason: "stop" });

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(toolCallsOf(result.events)).toHaveLength(0);
      expect(lastDone(result.events).stopReason).toBe("end");
    });
  });

  test("a mid-stream error object surfaces as one error event after the text so far", async () => {
    const body =
      chunk({ index: 0, delta: { content: "partial" }, finish_reason: null }) +
      sseFrame({ error: { message: "upstream went away", type: "server_error" } });

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.events).toEqual([{ type: "text", text: "partial" }, { type: "error", message: "upstream went away" }]);
    });
  });
});

describe("openai failures and aborts", () => {
  test("HTTP 500 with a JSON body yields retry notices then exactly one error event", async () => {
    const payload = { error: { message: "The server had an error processing your request", type: "server_error" } };

    await withServer(() => jsonResponse(payload, 500), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.thrown).toBeNull();
      // 500 is retryable, so retry notices precede one terminal error (providers/retry.ts).
      const errors = result.events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(result.events[result.events.length - 1]).toBe(errors[0]);
      expect(result.events.some((event) => event.type === "notice")).toBe(true);
      const error = asError(errors[0]);
      expect(error.message).toContain("openai HTTP 500");
      expect(error.message).toContain("server_error");
      expect(error.message).toContain("processing your request");
    });
  });

  test("server resets the socket after partial text: text so far then one error event (observed behaviour), never hangs", async () => {
    const frames = [
      chunk({ index: 0, delta: { content: "half " }, finish_reason: null }),
      chunk({ index: 0, delta: { content: "a thought" }, finish_reason: null }),
      sseFrame("[DONE]"),
    ];
    const body = frames.join("");
    const cuts = [Buffer.byteLength(frames[0]!, "utf8")];
    const gate = deferred();
    const server = startServer(() => sseResponse(body, { cuts, hold: gate.promise }));

    try {
      const result = run(providerFor(server), makeRequest());
      await waitFor(() => result.events.length >= 1);

      const cutAtMs = performance.now();
      server.stop(true);
      await result.done;

      expect(result.thrown).toBeNull();
      expect(performance.now() - cutAtMs).toBeLessThan(1000);
      expect(result.events[0]).toEqual({ type: "text", text: "half " });
      expect(result.events).toHaveLength(2);
      expect(asError(result.events[1]).message).toContain("openai stream failed");
    } finally {
      gate.resolve();
      server.stop();
    }
  });

  test("an abort mid-stream ends the iterator under a second with done/abort and no exception", async () => {
    const frames = [
      chunk({ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }),
      chunk({ index: 0, delta: { content: "lo" }, finish_reason: null }),
      sseFrame("[DONE]"),
    ];
    const body = frames.join("");
    const cuts = [Buffer.byteLength(frames[0]!, "utf8")];
    const gate = deferred();

    await withServer(
      () => sseResponse(body, { cuts, hold: gate.promise }),
      async (server) => {
        const controller = new AbortController();
        const result = run(providerFor(server), makeRequest({ signal: controller.signal }));
        await waitFor(() => result.events.length > 0);

        const abortedAt = performance.now();
        controller.abort();
        await result.done;
        const observed = performance.now() - abortedAt;

        gate.resolve();
        expect(result.thrown).toBeNull();
        expect(observed).toBeLessThan(1000);
        expect(result.events).toEqual([{ type: "text", text: "Hel" }, { type: "done", stopReason: "abort" }]);
      },
    );
  });

  test("an already-aborted signal never reaches the network", async () => {
    const controller = new AbortController();
    controller.abort();

    await withServer(() => sseResponse(chunk({ index: 0, delta: {}, finish_reason: "stop" })), async (server) => {
      const result = await collect(providerFor(server), makeRequest({ signal: controller.signal }));
      expect(result.events).toEqual([{ type: "done", stopReason: "abort" }]);
      expect(server.requests).toHaveLength(0);
    });
  });

  test("no messages to send yields one error event and sends nothing", async () => {
    await withServer(() => sseResponse(chunk({ index: 0, delta: {}, finish_reason: "stop" })), async (server) => {
      const result = await collect(providerFor(server), makeRequest({ messages: [] }));
      expect(result.events).toEqual([{ type: "error", message: "openai: nothing to send (no messages)" }]);
      expect(server.requests).toHaveLength(0);
    });
  });
});

describe("openai request shape", () => {
  test("POSTs /v1/chat/completions with the bearer token, system prompt, tools and max_tokens", async () => {
    const tools: ToolSpec[] = [
      { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ];

    await withServer(() => sseResponse(chunk({ index: 0, delta: { content: "ok" }, finish_reason: "stop" })), async (server) => {
      await collect(
        providerFor(server, { baseUrl: `${server.baseUrl}///` }),
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

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.headers["authorization"]).toBe("Bearer sk-oai-test");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toEqual({
        model: "hz-test-model",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "reading",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "file body", name: "read" },
        ],
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: tools[0]!.parameters } }],
        max_tokens: 128,
      });
    });
  });

  test("defaults max_tokens to 4096, or to the provider setting when there is one", async () => {
    await withServer(() => sseResponse(chunk({ index: 0, delta: {}, finish_reason: "stop" })), async (server) => {
      await collect(providerFor(server));
      await collect(providerFor(server, { maxTokens: 999 }));
      expect((server.requests[0]!.body as { max_tokens: number }).max_tokens).toBe(4096);
      expect((server.requests[1]!.body as { max_tokens: number }).max_tokens).toBe(999);
    });
  });

  test("omits the system turn and tools when there are none", async () => {
    await withServer(() => sseResponse(chunk({ index: 0, delta: {}, finish_reason: "stop" })), async (server) => {
      await collect(providerFor(server));
      const body = server.requests[0]!.body as Record<string, unknown>;
      expect("tools" in body).toBe(false);
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    });
  });
});

describe("openai message translation", () => {
  test("keeps a tool-calling assistant turn with null content and the tool answer", () => {
    expect(
      toOpenAiMessages([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", arguments: "" }] },
        { role: "tool", content: "body", toolCallId: "call_1", toolName: "read" },
      ]),
    ).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "body", name: "read" },
    ]);
  });

  test("drops tool messages without an id and fills an empty result", () => {
    expect(toOpenAiMessages([{ role: "tool", content: "orphan" }])).toEqual([]);
    expect(toOpenAiMessages([{ role: "tool", content: "", toolCallId: "call_1" }])).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "(no output)" },
    ]);
  });

  test("converts tool specs to the function wrapper and tolerates a missing list", () => {
    expect(toOpenAiTools([{ name: "a", description: "d", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "a", description: "d", parameters: { type: "object" } } },
    ]);
    expect(toOpenAiTools(undefined as unknown as ToolSpec[])).toEqual([]);
  });
});

/**
 * anthropic.test.ts — the Claude provider (POST /v1/messages, streamed).
 *
 * Every server is canned and local; the SSE bodies are cut into chunks at
 * deliberate byte offsets so the translation is exercised across writes, not
 * only on whole frames.
 */

import { describe, expect, test } from "bun:test";
import {
  createAnthropicProvider,
  toAnthropicMessages,
  toAnthropicTools,
} from "../../src/core/providers/anthropic";
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
const FULL_TEXT = `Hello, snowman ${SNOWMAN} ok`;
const TEXT_PIECES = ["Hel", "lo, ", `snowman ${SNOWMAN} ok`];

type AnthropicProvider = ReturnType<typeof createAnthropicProvider>;

function providerFor(server: CannedServer, extra: { maxTokens?: number; baseUrl?: string } = {}): AnthropicProvider {
  return createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: extra.baseUrl ?? server.baseUrl, maxTokens: extra.maxTokens });
}

/** The frames of a plain successful Claude turn. */
function textTurn(pieces: string[] = TEXT_PIECES): string {
  return (
    sseFrame({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 17 } } }, "message_start") +
    sseFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
    pieces.map((text) => sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta")).join("") +
    sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, "message_delta") +
    sseFrame({ type: "message_stop" }, "message_stop")
  );
}

async function collect(
  provider: AnthropicProvider,
  req = makeRequest(),
): Promise<{ events: ProviderEvent[]; thrown: unknown; elapsedMs: number }> {
  const result = run(provider, req);
  await result.done;
  return { events: result.events, thrown: result.thrown, elapsedMs: result.elapsedMs };
}

/** An error event, asserting the discriminant so the tests stay type-safe. */
function asError(event: ProviderEvent | undefined): Extract<ProviderEvent, { type: "error" }> {
  if (!event || event.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(event)}`);
  return event;
}

describe("anthropic text streaming", () => {
  test("translates text deltas in order, then done/end, and reassembles the full text", async () => {
    const body = textTurn();
    const cuts = [
      cutAt(body, "event: message_start", 3), // mid-line, inside "event:"
      cutAt(body, "data:", 2), // mid-line, inside "data:"
      cutAt(body, "\n\nevent:", 1), // exactly between the two newlines of a separator
      insideByte(body, SNOWMAN), // one byte into the 3-byte snowman
      cutAt(body, "message_stop", 5), // inside a JSON payload
    ];
    expect(cuts).toHaveLength(5);
    for (const cut of cuts) expect(splitIsAwkward(body, cut)).toBe(true);

    await withServer(
      () => sseResponse(body, { cuts }),
      async (server) => {
        const result = await collect(providerFor(server));

        expect(result.thrown).toBeNull();
        expect(result.events).toEqual([
          { type: "text", text: "Hel" },
          { type: "text", text: "lo, " },
          { type: "text", text: `snowman ${SNOWMAN} ok` },
          { type: "done", stopReason: "end", usage: { inputTokens: 17, outputTokens: 5 } },
        ]);
        expect(textOf(result.events)).toBe(FULL_TEXT);
        expect(server.requests).toHaveLength(1);
      },
    );
  });

  test("ignores unparsable and unknown frames and keeps translating the rest", async () => {
    const body =
      sseFrame('{"type":"content_block_delta", broken', "content_block_delta") +
      sseFrame({ type: "ping" }, "ping") +
      sseFrame('["type", "content_block_delta"]', "content_block_delta") +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "still here" } }, "content_block_delta") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" } }, "message_delta") +
      sseFrame("[DONE]");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.events).toEqual([{ type: "text", text: "still here" }, { type: "done", stopReason: "end" }]);
    });
  });

  test("a stream that only ends with [DONE] still produces exactly one done/end", async () => {
    const body =
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }, "content_block_delta") + sseFrame("[DONE]");

    await withServer(() => sseResponse(body, { cuts: [cutAt(body, "[DONE]", 4)] }), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.events).toEqual([{ type: "text", text: "partial" }, { type: "done", stopReason: "end" }]);
      expect(lastDone(result.events).usage).toBeUndefined();
    });
  });

  test("maps stop_reason max_tokens to done/max_tokens", async () => {
    const body =
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated answer" } }, "content_block_delta") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 100 } }, "message_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(lastDone(result.events)).toEqual({ type: "done", stopReason: "max_tokens", usage: { inputTokens: undefined, outputTokens: 100 } });
    });
  });
});

describe("anthropic tool use", () => {
  test("assembles one tool call from input_json_delta chunks split across frames and chunks", async () => {
    const args = `{"path": "caf\u00e9/${SNOWMAN}.txt", "limit": 3}`;
    const partials = [`{"path": "caf`, `\u00e9/${SNOWMAN}`, `.txt", "limit"`, `: 3}`];
    expect(partials.join("")).toBe(args);

    const body =
      sseFrame({ type: "message_start", message: { usage: { input_tokens: 42 } } }, "message_start") +
      sseFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me read it." } }, "content_block_delta") +
      sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
      sseFrame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01abc", name: "read", input: {} } }, "content_block_start") +
      partials.map((partial_json) => sseFrame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } }, "content_block_delta")).join("") +
      sseFrame({ type: "content_block_stop", index: 1 }, "content_block_stop") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }, "message_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    const cuts = [insideByte(body, SNOWMAN), cutAt(body, "tool_use", 6), cutAt(body, "input_json_delta", 9), cutAt(body, "\n\n", 1)];
    for (const cut of cuts) expect(splitIsAwkward(body, cut)).toBe(true);

    await withServer(
      () => sseResponse(body, { cuts }),
      async (server) => {
        const result = await collect(providerFor(server));
        expect(result.thrown).toBeNull();
        expect(result.events.map((event) => event.type)).toEqual(["text", "tool_call", "done"]);
        expect(result.events[0]).toEqual({ type: "text", text: "Let me read it." });

        const calls = toolCallsOf(result.events);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.id).toBe("toolu_01abc");
        expect(calls[0]!.name).toBe("read");
        expect(parseJson(calls[0]!.arguments)).toEqual({ path: `caf\u00e9/${SNOWMAN}.txt`, limit: 3 });
        expect(lastDone(result.events)).toEqual({ type: "done", stopReason: "tool_use", usage: { inputTokens: 42, outputTokens: 9 } });
      },
    );
  });

  test("a no-argument tool_use block (no input deltas) reports {} rather than an empty string", async () => {
    const body =
      sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_none", name: "todo", input: {} } }, "content_block_start") +
      sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" } }, "message_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      const calls = toolCallsOf(result.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.arguments).toBe("{}");
      expect(parseJson(calls[0]!.arguments)).toEqual({});
      expect(lastDone(result.events).stopReason).toBe("tool_use");
    });
  });

  test("a tool_use block whose input arrives whole in content_block_start keeps that input", async () => {
    const declared = { pattern: "**/*.ts", path: "." };
    const body =
      sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_whole", name: "glob", input: declared } }, "content_block_start") +
      sseFrame({ type: "content_block_stop", index: 0 }, "content_block_stop") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "tool_use" } }, "message_delta");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      const calls = toolCallsOf(result.events);
      expect(calls).toHaveLength(1);
      expect(parseJson(calls[0]!.arguments)).toEqual(declared);
    });
  });

  test("flushes a tool_use block that never received content_block_stop, and reports tool_use", async () => {
    const partial = '{"path": "a.tx';
    const body =
      sseFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_cut", name: "read", input: {} } }, "content_block_start") +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partial } }, "content_block_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      const calls = toolCallsOf(result.events);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.id).toBe("toolu_cut");
      // The adapter forwards exactly what arrived; validating an incomplete object is the caller's job.
      expect(calls[0]!.arguments).toBe(partial);
      expect(lastDone(result.events).stopReason).toBe("tool_use");
    });
  });

  test("a mid-stream error frame surfaces as one error event after the text so far", async () => {
    const body =
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } }, "content_block_delta") +
      sseFrame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "error");

    await withServer(() => sseResponse(body), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.events).toEqual([
        { type: "text", text: "partial answer" },
        { type: "error", message: "Overloaded" },
      ]);
    });
  });
});

describe("anthropic failures and aborts", () => {
  test("HTTP 429 with a JSON error body yields exactly one error event", async () => {
    const payload = { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } };

    await withServer(() => jsonResponse(payload, 429), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.thrown).toBeNull();
      expect(result.events).toHaveLength(1);
      const error = asError(result.events[0]);
      expect(error.message).toContain("429");
      expect(error.message).toContain("rate_limit_error");
      expect(error.message).toContain("per-minute rate limit");
    });
  });

  test("HTTP 500 mentions the status even when the body is not JSON", async () => {
    await withServer(
      () => new Response("upstream\n\n exploded", { status: 500, headers: { "content-type": "text/plain" } }),
      async (server) => {
        const result = await collect(providerFor(server));
        expect(result.events).toHaveLength(1);
        const error = asError(result.events[0]);
        expect(error.message).toContain("anthropic HTTP 500");
        expect(error.message).toContain("upstream exploded");
      },
    );
  });

  test("server resets the socket after partial text: text so far then one error event (observed behaviour), never hangs", async () => {
    const frames = [
      sseFrame({ type: "message_start", message: { usage: { input_tokens: 7 } } }, "message_start"),
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }, "content_block_delta"),
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, "content_block_delta"),
      sseFrame({ type: "message_stop" }, "message_stop"),
    ];
    const body = frames.join("");
    const cuts = [Buffer.byteLength(frames[0]! + frames[1]!, "utf8")];
    const gate = deferred();
    const server = startServer(() => sseResponse(body, { cuts, hold: gate.promise }));

    try {
      const result = run(providerFor(server), makeRequest());
      await waitFor(() => result.events.length >= 1);

      const cutAtMs = performance.now();
      server.stop(true); // the socket dies mid-stream, after the first text delta
      await result.done;

      expect(result.thrown).toBeNull();
      expect(performance.now() - cutAtMs).toBeLessThan(1000);
      expect(result.events[0]).toEqual({ type: "text", text: "Hel" });
      expect(result.events).toHaveLength(2);
      const error = asError(result.events[1]);
      expect(error.message).toContain("anthropic stream failed");
    } finally {
      gate.resolve();
      server.stop();
    }
  });

  test("server ends the SSE body cleanly after partial text: text so far plus done/end (observed behaviour)", async () => {
    const full =
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }, "content_block_delta") +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, "content_block_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    await withServer(() => sseResponse(full, { holdAfterByte: cutAt(full, "event: message_stop") }), async (server) => {
      const result = await collect(providerFor(server));
      expect(result.thrown).toBeNull();
      expect(result.events).toEqual([{ type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "done", stopReason: "end" }]);
      expect(textOf(result.events)).toBe("Hello");
    });
  });

  test("an abort mid-stream ends the iterator under a second with done/abort and no exception", async () => {
    const frames = [
      sseFrame({ type: "message_start", message: { usage: { input_tokens: 3 } } }, "message_start"),
      sseFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }, "content_block_delta"),
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, "content_block_delta"),
      sseFrame({ type: "message_stop" }, "message_stop"),
    ];
    const body = frames.join("");
    // The server writes up to (and including) the first text delta, then holds.
    const cuts = [Buffer.byteLength(frames.slice(0, 3).join(""), "utf8")];
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
        expect(result.elapsedMs).toBeLessThan(1000);
        expect(result.events).toEqual([{ type: "text", text: "Hel" }, { type: "done", stopReason: "abort" }]);
      },
    );
  });

  test("aborting before the server has sent a byte also ends promptly with done/abort", async () => {
    const gate = deferred();

    await withServer(() => sseResponse(textTurn(), { holdBefore: gate.promise }), async (server) => {
      const controller = new AbortController();
      const result = run(providerFor(server), makeRequest({ signal: controller.signal }));
      await waitFor(() => server.requests.length === 1);

      const abortedAt = performance.now();
      controller.abort();
      await result.done;
      const observed = performance.now() - abortedAt;

      gate.resolve();
      expect(result.thrown).toBeNull();
      expect(observed).toBeLessThan(1000);
      expect(result.events).toEqual([{ type: "done", stopReason: "abort" }]);
    });
  });

  test("an already-aborted signal never reaches the network", async () => {
    const controller = new AbortController();
    controller.abort();

    await withServer(() => sseResponse(textTurn()), async (server) => {
      const result = await collect(providerFor(server), makeRequest({ signal: controller.signal }));
      expect(result.thrown).toBeNull();
      expect(result.events).toEqual([{ type: "done", stopReason: "abort" }]);
      expect(server.requests).toHaveLength(0);
    });
  });

  test("a request that cannot connect reports one error event", async () => {
    const dead = startServer(() => new Response(""));
    const baseUrl = dead.baseUrl;
    dead.stop();

    const result = await collect(createAnthropicProvider({ apiKey: "k", baseUrl }));
    expect(result.thrown).toBeNull();
    expect(result.events).toHaveLength(1);
    expect(asError(result.events[0]).message).toContain("anthropic request failed");
  });

  test("no messages after the system prompt yields one error event and sends nothing", async () => {
    await withServer(() => sseResponse(textTurn()), async (server) => {
      const result = await collect(providerFor(server), makeRequest({ system: "be brief", messages: [{ role: "system", content: "ignored" }] }));
      expect(result.events).toEqual([{ type: "error", message: "anthropic: nothing to send (no messages after system)" }]);
      expect(server.requests).toHaveLength(0);
    });
  });
});

describe("anthropic request shape", () => {
  test("POSTs /v1/messages with the key, version header, system prompt, tools and max_tokens", async () => {
    const tools: ToolSpec[] = [
      { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ];

    await withServer(() => sseResponse(textTurn()), async (server) => {
      await collect(
        providerFor(server, { baseUrl: `${server.baseUrl}///` }),
        makeRequest({
          system: "be brief",
          maxTokens: 128,
          tools,
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "reading", toolCalls: [{ id: "toolu_1", name: "read", arguments: '{"path":"a.ts"}' }] },
            { role: "tool", content: "file body", toolCallId: "toolu_1", toolName: "read" },
          ],
        }),
      );

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/messages");
      expect(request.headers["x-api-key"]).toBe("sk-ant-test");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toEqual({
        model: "hz-test-model",
        max_tokens: 128,
        stream: true,
        system: "be brief",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "reading" },
              { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] },
        ],
        tools: [{ name: "read", description: "read a file", input_schema: tools[0]!.parameters }],
      });
    });
  });

  test("defaults max_tokens to 4096, or to the provider setting when there is one", async () => {
    await withServer(() => sseResponse(textTurn()), async (server) => {
      await collect(providerFor(server));
      await collect(providerFor(server, { maxTokens: 777 }));
      expect((server.requests[0]!.body as { max_tokens: number }).max_tokens).toBe(4096);
      expect((server.requests[1]!.body as { max_tokens: number }).max_tokens).toBe(777);
    });
  });

  test("omits system and tools when there are none", async () => {
    await withServer(() => sseResponse(textTurn()), async (server) => {
      await collect(providerFor(server));
      const body = server.requests[0]!.body as Record<string, unknown>;
      expect("system" in body).toBe(false);
      expect("tools" in body).toBe(false);
    });
  });
});

describe("anthropic message translation", () => {
  test("merges consecutive same-role turns and keeps tool results as user turns", () => {
    expect(
      toAnthropicMessages([
        { role: "system", content: "ignored" },
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok" },
        { role: "tool", content: "result", toolCallId: "t1", toolName: "read" },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
    ]);
  });

  test("drops tool messages without an id and fills an empty tool result with a placeholder", () => {
    expect(toAnthropicMessages([{ role: "tool", content: "orphan" }])).toEqual([]);
    expect(toAnthropicMessages([{ role: "tool", content: "", toolCallId: "t1" }])).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "(no output)" }] },
    ]);
  });

  test("an assistant tool call with unparsable arguments is replayed as an empty object", () => {
    expect(toAnthropicMessages([{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", arguments: "not json" }] }])).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    ]);
  });

  test("converts tool specs to input_schema and tolerates a missing list", () => {
    expect(toAnthropicTools([{ name: "a", description: "d", parameters: { type: "object" } }])).toEqual([
      { name: "a", description: "d", input_schema: { type: "object" } },
    ]);
    expect(toAnthropicTools(undefined as unknown as ToolSpec[])).toEqual([]);
  });
});

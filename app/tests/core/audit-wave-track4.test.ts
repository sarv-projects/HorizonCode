import { describe, expect, test } from "bun:test";
import { decodeModel, type Catalog } from "../../src/core/catalog/catalog";
import { enrichUsageCost, resolveRates, usageCostEventFields } from "../../src/core/usage-cost";
import { createAnthropicProvider } from "../../src/core/providers/anthropic";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import { createGoogleProvider } from "../../src/core/providers/google";
import { createOllamaProvider } from "../../src/core/providers/ollama";
import { makeProvider } from "../../src/core/providers/index";
import { checkUsageInvariant } from "../../src/core/providers/usage-invariant";
import { applyQuirks } from "../../src/core/providers/quirks";
import { fetchWithRetry } from "../../src/core/providers/retry";
import { CircuitBreaker, type BreakerConfig } from "../../src/core/providers/circuit-breaker";
import { ensureAlternatingRoles } from "../../src/core/providers/alternating-roles";
import { readSse, type SseMessage } from "../../src/core/providers/sse";
import type { HzConfig } from "../../src/core/config";
import type { ProviderEvent } from "../../src/contracts";
import { makeRequest, run, sseFrame, sseResponse, withServer } from "../providers/helpers";

function catalogWith(provider: string, modelId: string, cost: Record<string, unknown>): Catalog {
  const model = decodeModel(provider, modelId, {
    id: modelId,
    limit: { context: 128_000 },
    cost,
  });
  if (typeof model === "string") throw new Error(model);
  return {
    providers: {
      [provider]: { id: provider, defaultModel: modelId, models: { [modelId]: model } },
    },
    rejected: [],
  };
}

function breakerCfg(over: Partial<BreakerConfig> = {}): BreakerConfig {
  return {
    windowDurationMs: 60_000,
    minSamples: 2,
    errorRateThreshold: 0.5,
    openDurationMs: 1_000,
    halfOpenMaxProbes: 1,
    failureStatuses: [429, 500, 502, 503, 504],
    enabled: true,
    ...over,
  };
}

describe("Track 4 — Providers & Billing Fixes", () => {
  test("P1 #1a: Anthropic cached input is not double-subtracted in usage-cost and satisfies usage-invariant", async () => {
    const body =
      sseFrame(
        {
          type: "message_start",
          message: {
            id: "msg_cache",
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 500,
            },
          },
        },
        "message_start",
      ) +
      sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, "content_block_delta") +
      sseFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } }, "message_delta") +
      sseFrame({ type: "message_stop" }, "message_stop");

    await withServer(() => sseResponse(body), async (server) => {
      const provider = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: server.baseUrl });
      const res = run(provider, makeRequest());
      await res.done;
      const done = res.events.find((e): e is Extract<ProviderEvent, { type: "done" }> => e.type === "done");
      expect(done?.usage).toEqual({
        inputTokens: 800,
        outputTokens: 50,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 500,
        nonCachedInputTokens: 100,
      });
      expect(checkUsageInvariant(done!.usage!)).toEqual({ ok: true, violations: [] });

      const enriched = enrichUsageCost(done!.usage!, "anthropic", "claude-3-5-sonnet");
      expect(enriched.cost?.inputUsd).toBeCloseTo((100 / 1_000_000) * 3, 12);
      expect(enriched.cost?.cacheWriteUsd).toBeCloseTo((200 / 1_000_000) * 3.75, 12);
      expect(enriched.cost?.cacheReadUsd).toBeCloseTo((500 / 1_000_000) * 0.3, 12);
      expect(enriched.cost?.outputUsd).toBeCloseTo((50 / 1_000_000) * 15, 12);
    });

    // Even when inputTokens was not pre-summed, explicit nonCachedInputTokens prevents double subtraction.
    const direct = enrichUsageCost(
      { inputTokens: 100, nonCachedInputTokens: 100, cacheReadInputTokens: 500, outputTokens: 0 },
      "anthropic",
      "claude",
    );
    expect(direct.cost?.inputUsd).toBeCloseTo((100 / 1_000_000) * 3, 12);
  });

  test("P1 #1b: resolveRates defaults omitted catalog cache rates to 0 (not Claude Sonnet fallback)", () => {
    const catalog = catalogWith("nvidia", "free-model", { input: 0, output: 0 });
    const resolved = resolveRates("nvidia", "free-model", catalog);
    expect(resolved.rates).toEqual({
      inputPerM: 0,
      outputPerM: 0,
      cacheReadPerM: 0,
      cacheWritePerM: 0,
    });

    const fields = usageCostEventFields(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 500_000 },
      "nvidia",
      "free-model",
      catalog,
    );
    expect(fields?.costMicroUsd).toBe(0);

    const partial = catalogWith("nvidia", "paid-no-cache-write", { input: 1, output: 2, cache_read: 0.25 });
    const partialResolved = resolveRates("nvidia", "paid-no-cache-write", partial);
    expect(partialResolved.rates.cacheReadPerM).toBe(0.25);
    expect(partialResolved.rates.cacheWritePerM).toBe(0);
  });

  test("P1 #2: usage-invariant deduplicates cacheWriteInputTokens and cacheCreationInputTokens", () => {
    const res = checkUsageInvariant({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 20,
      cacheCreationInputTokens: 20,
      nonCachedInputTokens: 50,
      totalTokens: 120,
    });
    expect(res).toEqual({ ok: true, violations: [] });
  });

  test("P1 #3: trim_tool_call_ids truncates both tool_calls[].id and role=tool tool_call_id to 40 chars", () => {
    const longId = "call_" + "a".repeat(60);
    const body: Record<string, unknown> = {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: longId, type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: longId, name: "read", content: "ok" },
      ],
    };
    const applied = applyQuirks({ provider: "groq", model: "llama-3.3-70b-versatile", baseUrl: "https://api.groq.com" }, body);
    expect(applied).toContain("trim_tool_call_ids");
    const msgs = body.messages as Array<Record<string, unknown>>;
    const callId = ((msgs[0]!.tool_calls as Array<{ id: string }>)[0]!).id;
    const resultId = msgs[1]!.tool_call_id as string;
    expect(callId).toHaveLength(40);
    expect(resultId).toHaveLength(40);
    expect(resultId).toBe(callId);
  });

  test("P1 #4: custom headers merge ahead of protocol headers across anthropic, openai, google, ollama, and makeProvider", async () => {
    // 1) Anthropic
    await withServer(
      () =>
        sseResponse(
          sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, "content_block_delta") +
            sseFrame({ type: "message_stop" }, "message_stop"),
        ),
      async (server) => {
        const provider = createAnthropicProvider({
          apiKey: "real-ant-key",
          baseUrl: server.baseUrl,
          headers: { "x-custom-tenant": "acme", "x-api-key": "spoofed", "content-type": "text/plain" },
        });
        const r = run(provider, makeRequest());
        await r.done;
        expect(server.requests[0]!.headers["x-custom-tenant"]).toBe("acme");
        expect(server.requests[0]!.headers["x-api-key"]).toBe("real-ant-key");
        expect(server.requests[0]!.headers["content-type"]).toBe("application/json");
      },
    );

    // 2) OpenAI
    await withServer(
      () =>
        sseResponse(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        ),
      async (server) => {
        const provider = createOpenAiProvider({
          apiKey: "real-oai-key",
          baseUrl: server.baseUrl,
          headers: { "x-custom-tenant": "acme", authorization: "Bearer spoofed", "content-type": "text/plain" },
        });
        const r = run(provider, makeRequest());
        await r.done;
        expect(server.requests[0]!.headers["x-custom-tenant"]).toBe("acme");
        expect(server.requests[0]!.headers["authorization"]).toBe("Bearer real-oai-key");
        expect(server.requests[0]!.headers["content-type"]).toBe("application/json");
      },
    );

    // 3) Google
    let googleHeaders: Record<string, string> = {};
    const googleProvider = createGoogleProvider({
      apiKey: "real-goog-key",
      headers: { "x-custom-tenant": "acme", "x-goog-api-key": "spoofed", "content-type": "text/plain" },
      fetch: async (_url, init) => {
        googleHeaders = (init?.headers ?? {}) as Record<string, string>;
        return sseResponse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`);
      },
    });
    const gr = run(googleProvider, makeRequest({ model: "gemini-2.5-flash" }));
    await gr.done;
    expect(googleHeaders["x-custom-tenant"]).toBe("acme");
    expect(googleHeaders["x-goog-api-key"]).toBe("real-goog-key");
    expect(googleHeaders["content-type"]).toBe("application/json");

    // 4) Ollama
    let ollamaHeaders: Record<string, string> = {};
    const ollamaProvider = createOllamaProvider({
      apiKey: "real-ollama-key",
      headers: { "x-custom-tenant": "acme", authorization: "Bearer spoofed", "content-type": "text/plain" },
      fetch: async (_url, init) => {
        ollamaHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const or = run(ollamaProvider, makeRequest({ model: "llama3" }));
    await or.done;
    expect(ollamaHeaders["x-custom-tenant"]).toBe("acme");
    expect(ollamaHeaders["authorization"]).toBe("Bearer real-ollama-key");
    expect(ollamaHeaders["content-type"]).toBe("application/json");

    // 5) makeProvider forwards resolved.headers (anthropic-messages path)
    await withServer(
      () =>
        sseResponse(
          sseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, "content_block_delta") +
            sseFrame({ type: "message_stop" }, "message_stop"),
        ),
      async (server) => {
        const cfg = {
          provider: "custom-ant",
          model: "claude-test",
          apiKey: "k",
          resolved: {
            name: "custom-ant",
            protocol: "anthropic-messages",
            baseUrl: server.baseUrl,
            credential: { kind: "apiKey", value: "k" },
            wantsKey: true,
            headers: { "x-routed-header": "yes" },
          },
        } as unknown as HzConfig;
        const p = makeProvider(cfg);
        const r = run(p, makeRequest());
        await r.done;
        expect(server.requests[0]!.headers["x-routed-header"]).toBe("yes");
      },
    );
  });

  test("P1 #5: retry honors x-should-retry: true on 400 and 429 QUOTA; breaker records success only on 2xx and ignores user aborts", async () => {
    // 5a: x-should-retry: true overrides non-retryable 400
    let hits400 = 0;
    const s400 = Bun.serve({
      port: 0,
      fetch() {
        hits400 += 1;
        if (hits400 === 1) return new Response("try again", { status: 400, headers: { "x-should-retry": "true" } });
        return new Response("ok", { status: 200 });
      },
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${s400.port}`, { method: "POST" }, { baseDelayMs: 1, attempts: 3 });
      expect(res.status).toBe(200);
      expect(hits400).toBe(2);
    } finally {
      s400.stop(true);
    }

    // 5b: x-should-retry: true overrides 429 QUOTA attempt clamp
    let hitsQuota = 0;
    const sQuota = Bun.serve({
      port: 0,
      fetch() {
        hitsQuota += 1;
        if (hitsQuota === 1) {
          return new Response("insufficient quota", { status: 429, headers: { "x-should-retry": "true" } });
        }
        return new Response("ok", { status: 200 });
      },
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${sQuota.port}`, { method: "POST" }, { baseDelayMs: 1, attempts: 3 });
      expect(res.status).toBe(200);
      expect(hitsQuota).toBe(2);
    } finally {
      sQuota.stop(true);
    }

    // 5c: HTTP 400 does NOT record breaker success (half-open breaker stays half-open, not closed)
    let ms = 1000;
    const breaker = new CircuitBreaker(breakerCfg({ minSamples: 2, openDurationMs: 100 }), { now: () => ms });
    breaker.record("failure");
    breaker.record("failure");
    expect(breaker.state()).toBe("open");
    ms += 101;
    const sClientErr = Bun.serve({ port: 0, fetch: () => new Response("bad req", { status: 400 }) });
    try {
      const res = await fetchWithRetry(
        `http://127.0.0.1:${sClientErr.port}`,
        { method: "POST" },
        { breaker, attempts: 1, baseDelayMs: 1 },
      );
      expect(res.status).toBe(400);
      expect(breaker.state()).toBe("half_open");
    } finally {
      sClientErr.stop(true);
    }

    // 5d: User abort does NOT record breaker failure
    const abortBreaker = new CircuitBreaker(breakerCfg({ minSamples: 1, errorRateThreshold: 0.5 }), { now: () => ms });
    const controller = new AbortController();
    const sSlow = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(500);
        return new Response("ok");
      },
    });
    try {
      setTimeout(() => controller.abort(), 20);
      await expect(
        fetchWithRetry(
          `http://127.0.0.1:${sSlow.port}`,
          { method: "POST", signal: controller.signal },
          { breaker: abortBreaker, attempts: 1, baseDelayMs: 1 },
        ),
      ).rejects.toThrow();
      expect(abortBreaker.state()).toBe("closed");
      expect(abortBreaker.errorRate()).toBe(0);
    } finally {
      sSlow.stop(true);
    }
  });

  test("P1 #6: ensureAlternatingRoles preserves all message fields and exempts role=tool from stub insertion", () => {
    const input = [
      { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "read", content: "out1" },
      { role: "tool", tool_call_id: "c2", name: "grep", content: "out2" },
    ];
    const out = ensureAlternatingRoles(input);
    expect(out).toHaveLength(5);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect((out[0] as Record<string, unknown>).cache_control).toEqual({ type: "ephemeral" });
    expect((out[2] as Record<string, unknown>).tool_calls).toEqual(input[2]!.tool_calls);
    expect((out[3] as Record<string, unknown>).tool_call_id).toBe("c1");
    expect((out[3] as Record<string, unknown>).name).toBe("read");
    expect((out[4] as Record<string, unknown>).tool_call_id).toBe("c2");
    expect((out[4] as Record<string, unknown>).name).toBe("grep");
  });

  test("P2 #7: readSse buffers trailing \\r across TCP chunk boundaries so split \\r\\n does not become \\n\\n", async () => {
    const encoder = new TextEncoder();
    const chunks = ["event: delta\r", "\ndata: hello\r\n\r", "\nevent: done\r", "\ndata: bye\r\n\r\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const out: SseMessage[] = [];
    for await (const msg of readSse(stream)) out.push(msg);
    expect(out).toEqual([
      { event: "delta", data: "hello" },
      { event: "done", data: "bye" },
    ]);
  });

  test("P2 #8: CircuitBreaker defaults to monotonic performance.now() clock while keeping injectable clock support", () => {
    const origDateNow = Date.now;
    try {
      const b = new CircuitBreaker(breakerCfg({ minSamples: 2, openDurationMs: 5_000 }));
      b.record("failure");
      b.record("failure");
      expect(b.state()).toBe("open");
      // Jump wall clock forward by 1 hour: monotonic breaker must stay open!
      Date.now = () => origDateNow() + 3_600_000;
      expect(() => b.check()).toThrow();
      expect(b.state()).toBe("open");
    } finally {
      Date.now = origDateNow;
    }

    // Injectable clock still works deterministically
    let t = 0;
    const injected = new CircuitBreaker(breakerCfg({ minSamples: 2, openDurationMs: 500 }), { now: () => t });
    injected.record("failure");
    injected.record("failure");
    expect(injected.state()).toBe("open");
    t += 501;
    expect(injected.check()).toBeUndefined();
    expect(injected.state()).toBe("half_open");
  });
});

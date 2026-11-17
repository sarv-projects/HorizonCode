/**
 * timeouts.test.ts — a provider that never answers, or stalls mid-answer, must
 * fail typed instead of hanging the turn.
 *
 * Every case stands up a real local Bun.serve and injects short budgets through
 * the adapter settings, so the whole suite stays well under five seconds. The
 * three phases are covered separately:
 *
 *  - `request`: the socket is accepted but headers never arrive;
 *  - `idle`: headers arrive, a frame streams, then the body goes silent;
 *  - `total`: the stream keeps trickling, so only the whole-turn cap can stop it.
 *
 * A human abort is checked to still end in `done/abort`, never a timeout error.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../../src/contracts";
import { createAnthropicProvider } from "../../src/core/providers/anthropic";
import { createGoogleProvider } from "../../src/core/providers/google";
import { createOllamaProvider } from "../../src/core/providers/ollama";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import { fetchWithRetry } from "../../src/core/providers/retry";
import { readSse } from "../../src/core/providers/sse";
import {
  ProviderTimeoutError,
  isProviderTimeoutError,
  resolveProviderTimeouts,
  type ProviderTimeoutOptions,
} from "../../src/core/providers/timeout";
import { lastDone, makeRequest, run, sseFrame, waitFor } from "./helpers";

const encoder = new TextEncoder();

interface StubServer {
  readonly baseUrl: string;
  stop(): void;
}

/** A throwaway server on an ephemeral port; `stop(true)` also drops sockets. */
function serve(handler: () => Response | Promise<Response>): StubServer {
  const server = Bun.serve({ port: 0, fetch: () => handler() });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** A response whose body sends nothing and never ends. */
function neverHeaders(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function stallAfter(firstFrame: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstFrame));
        // The body stays open with no further bytes: the idle timer must fire.
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function timeoutOptions(overrides: ProviderTimeoutOptions): ProviderTimeoutOptions {
  return { requestMs: 1_000, totalMs: 3_000, idleMs: 1_000, ...overrides };
}

function errorOf(events: ProviderEvent[]): Extract<ProviderEvent, { type: "error" }> {
  const event = events.find((entry): entry is Extract<ProviderEvent, { type: "error" }> => entry.type === "error");
  if (!event) throw new Error(`expected an error event, got ${JSON.stringify(events)}`);
  return event;
}

describe("fetchWithRetry — headers budget", () => {
  test("a server that accepts and never sends headers throws a typed request timeout", async () => {
    const stub = serve(neverHeaders);
    try {
      const started = Date.now();
      const failure = await fetchWithRetry(
        `${stub.baseUrl}/v1/chat/completions`,
        { method: "POST" },
        { attempts: 1, baseDelayMs: 1, timeouts: { requestMs: 120, totalMs: 2_000 } },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      const elapsed = Date.now() - started;
      expect(isProviderTimeoutError(failure)).toBe(true);
      expect((failure as ProviderTimeoutError).kind).toBe("request");
      expect((failure as ProviderTimeoutError).timeoutMs).toBe(120);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });

  test("the total budget stops the retry loop even when every attempt times out", async () => {
    const stub = serve(neverHeaders);
    try {
      const started = Date.now();
      const failure = await fetchWithRetry(
        `${stub.baseUrl}/v1/chat/completions`,
        { method: "POST" },
        {
          attempts: 20,
          baseDelayMs: 1,
          maxDelayMs: 5,
          timeouts: { requestMs: 60, totalMs: 220 },
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(isProviderTimeoutError(failure)).toBe(true);
      expect((failure as ProviderTimeoutError).kind).toBe("total");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });
});

describe("readSse — idle budget", () => {
  test("a silent stream rejects with a typed idle timeout instead of waiting forever", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseFrame({ type: "message_start" })));
        // No close: a provider/proxy that died mid-stream looks exactly like this.
      },
    });
    const seen: string[] = [];
    const failure = await (async (): Promise<unknown> => {
      try {
        for await (const message of readSse(body, { idleTimeoutMs: 80 })) seen.push(message.data);
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(seen).toEqual([JSON.stringify({ type: "message_start" })]);
    expect(isProviderTimeoutError(failure)).toBe(true);
    expect((failure as ProviderTimeoutError).kind).toBe("idle");
  });
});

describe("openai adapter — a hanging provider fails the turn typed", () => {
  test("headers never arrive: one typed TIMEOUT error, not a hang", async () => {
    const stub = serve(neverHeaders);
    try {
      const provider = createOpenAiProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ requestMs: 120 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("openai request timed out");
      expect(error.message).toContain("no response headers");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });

  test("headers arrive then the stream stalls: text, then a typed idle timeout", async () => {
    const stub = serve(() =>
      stallAfter(sseFrame({ choices: [{ index: 0, delta: { content: "partial" } }] })),
    );
    try {
      const provider = createOpenAiProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ idleMs: 100 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      expect(result.events.some((event) => event.type === "text")).toBe(true);
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("openai stream timed out");
      expect(error.message).toContain("no data for 100ms");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });

  test("a trickling stream is still capped by the total budget", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stub = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(sseFrame({ choices: [{ index: 0, delta: { content: "." } }] })));
                } catch {
                  if (timer) clearInterval(timer);
                }
              }, 40);
            },
            cancel() {
              if (timer) clearInterval(timer);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    try {
      const provider = createOpenAiProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ idleMs: 1_000, totalMs: 220 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("total budget");
      // Loaded hosts can overshoot a 220 ms total budget by ~2 s under the
      // full gate; the typed failure is the assertion, not wall-clock precision.
      expect(result.elapsedMs).toBeLessThan(5_000);
    } finally {
      if (timer) clearInterval(timer);
      stub.stop();
    }
  });

  test("a human abort still ends in done/abort, not a timeout", async () => {
    const controller = new AbortController();
    const stub = serve(() =>
      stallAfter(sseFrame({ choices: [{ index: 0, delta: { content: "partial" } }] })),
    );
    try {
      const provider = createOpenAiProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ idleMs: 5_000, totalMs: 5_000 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest({ signal: controller.signal }));
      await waitFor(() => result.events.some((event) => event.type === "text"));
      controller.abort();
      await result.done;
      expect(result.events.some((event) => event.type === "error")).toBe(false);
      expect(lastDone(result.events).stopReason).toBe("abort");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });
});

describe("anthropic and google — same budgets, same typed failures", () => {
  test("anthropic: headers never arrive and the request times out typed", async () => {
    const stub = serve(neverHeaders);
    try {
      const provider = createAnthropicProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ requestMs: 120 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("anthropic request timed out");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });

  test("google: a stall after headers becomes a typed idle timeout", async () => {
    const stub = serve(() =>
      stallAfter(sseFrame({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })),
    );
    try {
      const provider = createGoogleProvider({
        apiKey: "k",
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ idleMs: 100 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      expect(result.events.some((event) => event.type === "text")).toBe(true);
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("google stream timed out");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });

  test("ollama: the NDJSON reader is idle-guarded too", async () => {
    const firstLine = `${JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false })}\n`;
    const stub = serve(() => stallAfter(firstLine));
    try {
      const provider = createOllamaProvider({
        baseUrl: stub.baseUrl,
        timeouts: timeoutOptions({ idleMs: 100 }),
        retry: { attempts: 1 },
      });
      const result = run(provider, makeRequest());
      await result.done;
      expect(result.events.some((event) => event.type === "text")).toBe(true);
      const error = errorOf(result.events);
      expect(error.code).toBe("TRANSIENT");
      expect(error.message).toContain("ollama stream timed out");
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      stub.stop();
    }
  });
});

describe("timeout configuration", () => {
  test("HZ_PROVIDER_* supplies the defaults and explicit options win (0 disables)", () => {
    const env = {
      HZ_PROVIDER_TIMEOUT_MS: "111",
      HZ_PROVIDER_TOTAL_TIMEOUT_MS: "222",
      HZ_PROVIDER_IDLE_TIMEOUT_MS: "333",
    } as NodeJS.ProcessEnv;
    expect(resolveProviderTimeouts({}, env)).toEqual({ requestMs: 111, totalMs: 222, idleMs: 333 });
    expect(resolveProviderTimeouts({ requestMs: 5, idleMs: 0 }, env)).toEqual({
      requestMs: 5,
      totalMs: 222,
      idleMs: 0,
    });
    expect(
      resolveProviderTimeouts({}, { HZ_PROVIDER_TIMEOUT_MS: "not-a-number", HZ_PROVIDER_IDLE_TIMEOUT_MS: "" } as NodeJS.ProcessEnv),
    ).toEqual({ requestMs: 30_000, totalMs: 300_000, idleMs: 60_000 });
  });
});

/**
 * retry.test.ts — transient provider failures must not kill the turn.
 *
 * Before this existed, one 429 (rate limit), 529 (overloaded) or connection
 * reset failed the whole turn. These tests pin the policy that recovery rests
 * on: which statuses are retried, that a non-retryable status is returned
 * untouched (retrying a malformed request only burns tokens), that
 * `Retry-After` is honoured rather than guessed under, that attempts are
 * bounded, that the abort signal interrupts a backoff immediately, and that the
 * real adapters actually route their request through it and tell the human.
 *
 * Servers bind port 0 and are stopped in `finally`, so the suite never needs a
 * fixed port and never leaves one occupied.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../../src/contracts";
import { createOpenAiProvider } from "../../src/core/providers/openai";
import {
  backoffDelay,
  delay,
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfter,
  retryNotice,
} from "../../src/core/providers/retry";

interface Stub {
  url: string;
  hits: number;
  stop(): void;
}

/** A server that answers the first `failures` requests with `status`, then `ok`. */
async function flakyServer(status: number, failures: number, headers: Record<string, string> = {}): Promise<Stub> {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      if (hits <= failures) return new Response("busy", { status, headers });
      return new Response("ok", { status: 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    get hits() {
      return hits;
    },
    stop: () => server.stop(true),
  } as Stub;
}

describe("retry policy — what is worth trying again", () => {
  test("rate limits, overload and server faults are retryable; client errors are not", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    // Retrying these would re-send a request the server has already judged.
    for (const status of [400, 401, 403, 404, 413, 422, 451]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  test("Retry-After parses seconds and HTTP dates, and rejects what it cannot read", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(" 30 ")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const at = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(at);
    expect(parsed).not.toBeNull();
    // The HTTP-date form is truncated to whole seconds, so allow the slack.
    expect(parsed as number).toBeGreaterThan(3_000);
    expect(parsed as number).toBeLessThanOrEqual(5_000);
  });

  test("backoff grows, stays bounded, and obeys a server-stated Retry-After", () => {
    const fixed = (): number => 1;
    const step = (attempt: number): number => backoffDelay(attempt, { random: fixed });
    expect(step(1)).toBe(500);
    expect(step(2)).toBe(1000);
    expect(step(3)).toBe(2000);
    // Never above the ceiling, however long the run goes on.
    const ceiling = 8_000;
    for (const attempt of [4, 5, 10, 40]) {
      const value = backoffDelay(attempt, { random: fixed, maxDelayMs: ceiling });
      expect(value).toBeLessThanOrEqual(ceiling);
      expect(value).toBeGreaterThan(0);
    }
    // A stated Retry-After wins — guessing lower is how a client gets banned.
    expect(backoffDelay(1, { retryAfterMs: 4_000, random: fixed })).toBe(4_000);
    // ...but never beyond the cap the caller set.
    expect(backoffDelay(1, { retryAfterMs: 600_000, maxDelayMs: 5_000, random: fixed })).toBe(5_000);
  });

  test("jitter keeps every delay at or above half the step, and never negative", () => {
    for (const attempt of [1, 2, 3, 4]) {
      const base = 500 * 2 ** (attempt - 1);
      for (let i = 0; i < 50; i += 1) {
        const value = backoffDelay(attempt, { maxDelayMs: 20_000 });
        expect(value).toBeGreaterThanOrEqual(Math.floor(base / 2));
        expect(value).toBeLessThanOrEqual(base);
      }
    }
  });

  test("the retry notice names the cause, the wait and the attempt number", () => {
    expect(retryNotice("openai", { attempt: 1, status: 429, delayMs: 2_000 }, 4)).toBe(
      "openai: HTTP 429; retrying in 2.0s (attempt 2 of 4)",
    );
    expect(retryNotice("anthropic", { attempt: 1, error: new Error("ECONNRESET"), delayMs: 250 }, 4)).toContain(
      "connection error",
    );
  });

  test("delay resolves immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await delay(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("fetchWithRetry — the request-phase recovery window", () => {
  test("a 429 that clears returns the good response and reports the retry", async () => {
    const stub = await flakyServer(429, 1);
    const seen: Array<{ attempt: number; status?: number }> = [];
    try {
      const response = await fetchWithRetry(stub.url, { method: "POST" }, { baseDelayMs: 5, onRetry: (info) => seen.push(info) });
      expect(response.status).toBe(200);
      expect(stub.hits).toBe(2);
      expect(seen.map((entry) => entry.status)).toEqual([429]);
    } finally {
      stub.stop();
    }
  });

  test("429 with quota wording is not retried (route on code)", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("insufficient quota for this model", { status: 429 });
      },
    });
    try {
      const response = await fetchWithRetry(
        `http://127.0.0.1:${server.port}/v1/chat/completions`,
        { method: "POST" },
        { baseDelayMs: 1, attempts: 4 },
      );
      expect(response.status).toBe(429);
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a 400 is returned untouched — one request, no retry", async () => {
    const stub = await flakyServer(400, 99);
    try {
      const response = await fetchWithRetry(stub.url, { method: "POST" }, { baseDelayMs: 1 });
      expect(response.status).toBe(400);
      expect(stub.hits).toBe(1);
    } finally {
      stub.stop();
    }
  });

  test("attempts are bounded: four 503s produce four requests and the last response", async () => {
    const stub = await flakyServer(503, 99);
    let retries = 0;
    try {
      const response = await fetchWithRetry(stub.url, { method: "POST" }, { attempts: 4, baseDelayMs: 1, onRetry: () => { retries += 1; } });
      // Returned rather than thrown: the caller surfaces the server's own text.
      expect(response.status).toBe(503);
      expect(stub.hits).toBe(4);
      expect(retries).toBe(3);
    } finally {
      stub.stop();
    }
  });

  test("a stated Retry-After is actually waited out", async () => {
    const stub = await flakyServer(429, 1, { "retry-after": "1" });
    try {
      const started = Date.now();
      const response = await fetchWithRetry(stub.url, { method: "POST" }, {});
      const elapsed = Date.now() - started;
      expect(response.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(900);
    } finally {
      stub.stop();
    }
  });

  test("aborting during the backoff stops at once rather than waiting it out", async () => {
    const stub = await flakyServer(429, 99);
    const controller = new AbortController();
    try {
      const started = Date.now();
      const pending = fetchWithRetry(stub.url, { method: "POST", signal: controller.signal }, { baseDelayMs: 30_000 });
      setTimeout(() => controller.abort(), 100);
      // The retry loop unwinds through the normal fetch error path on abort.
      await pending.catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(stub.hits).toBe(1);
    } finally {
      stub.stop();
    }
  });
});

describe("the adapters route through it and say so", () => {
  async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
    const out: ProviderEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  test("openai: a 429 that clears yields a notice, then the real answer", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        hits += 1;
        if (hits === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "recovered" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const provider = createOpenAiProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}`, maxTokens: 32 });
      const events = await collect(
        provider.stream({
          model: "gpt-4o",
          system: "",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      );
      const notices = events.filter((event) => event.type === "notice");
      expect(notices.length).toBe(1);
      expect((notices[0] as { message: string }).message).toContain("HTTP 429");
      // The turn recovered rather than failing: text arrived and it ended cleanly.
      expect(events.some((event) => event.type === "text")).toBe(true);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(hits).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("openai: a persistent 5xx still fails the turn honestly after retrying", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 });
      },
    });
    try {
      const provider = createOpenAiProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}` });
      const events = await collect(
        provider.stream({
          model: "gpt-4o",
          system: "",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      );
      const error = events.find((event) => event.type === "error") as { message: string } | undefined;
      expect(error).toBeDefined();
      expect(error?.message).toContain("HTTP 500");
      expect(error?.message).toContain("upstream exploded");
      expect(hits).toBe(4);
    } finally {
      server.stop(true);
    }
  });
});

/**
 * helpers.ts — offline HTTP fixtures for the provider tests.
 *
 * Every test stands up a real Bun.serve on an ephemeral port and points the
 * provider at http://localhost:<port> through `baseUrl`; nothing here reaches
 * the network. The SSE bodies are byte-level controlled: a test chooses the
 * exact offsets where the server flushes, which is how the parsers get split
 * mid-line, mid-frame and inside a multi-byte character.
 */

import type { Provider, ProviderEvent, ProviderRequest } from "../../src/contracts";

const encoder = new TextEncoder();

/* ------------------------------ SSE building ------------------------------ */

/** One SSE frame: an optional `event:` line followed by the JSON payload. */
export function sseFrame(payload: unknown, event?: string): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return (event ? `event: ${event}\n` : "") + `data: ${data}\n\n`;
}

/** The byte offset of `needle` in `text` (plus `delta`) — a chunk boundary. */
export function cutAt(text: string, needle: string, delta = 0): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`cutAt: ${JSON.stringify(needle)} not found in the body`);
  return Buffer.byteLength(text.slice(0, index), "utf8") + delta;
}

/** The byte offset just inside the first `needle` character (a multi-byte split). */
export function insideByte(text: string, needle: string): number {
  return cutAt(text, needle, 1);
}

/** Cut `text` into the chunks a server would flush, starting at `cuts`. */
export function chunkBody(text: string, cuts: number[] = []): { chunks: Uint8Array[]; starts: number[] } {
  const bytes = encoder.encode(text);
  const starts = [...new Set([0, ...cuts.filter((c) => Number.isInteger(c) && c > 0 && c < bytes.length), bytes.length])].sort(
    (a, b) => a - b,
  );
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < starts.length - 1; i += 1) chunks.push(bytes.slice(starts[i], starts[i + 1]));
  return { chunks, starts };
}

/**
 * False when the offset falls exactly between two SSE frames (the previous
 * chunk ends a frame, the next starts a new field). The tests assert their
 * split points are awkward, i.e. that this returns true.
 */
export function splitIsAwkward(text: string, offset: number): boolean {
  const bytes = Buffer.from(text, "utf8");
  const before = bytes.subarray(0, offset).toString("utf8");
  const after = bytes.subarray(offset).toString("utf8");
  return !(before.endsWith("\n\n") && /^(event|data|:|$)/.test(after));
}

/* ---------------------------- streaming bodies ---------------------------- */

export interface StreamOptions {
  /** Byte offsets where a new chunk begins (the deliberate split points). */
  cuts?: number[];
  /** Milliseconds to wait after each chunk; default 1. */
  delays?: number[];
  /** Stop writing after this many bytes and leave the body open (default never). */
  holdAfterByte?: number;
  /** Wait on this promise before writing anything at all. */
  holdBefore?: Promise<void>;
  /** Wait on this promise after the first chunk before writing the rest. */
  hold?: Promise<void>;
  /** Wait this long after the last chunk before closing the body. */
  holdOpenMs?: number;
  headers?: Record<string, string>;
}

/**
 * A chunked `text/event-stream` body. Writes each chunk separately so the
 * parser sees every split point a real server (or a proxy) could produce.
 */
export function streamBody(text: string, opts: StreamOptions = {}): ReadableStream<Uint8Array> {
  const { chunks, starts } = chunkBody(text, opts.cuts);
  const holdAfter = opts.holdAfterByte ?? Number.POSITIVE_INFINITY;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (opts.holdBefore) await opts.holdBefore;
        for (let i = 0; i < chunks.length; i += 1) {
          if (starts[i] >= holdAfter) break; // the rest of the body never arrives
          controller.enqueue(chunks[i]);
          if (i === 0 && opts.hold) await opts.hold;
          const delay = opts.delays ? (opts.delays[i] ?? 0) : 1;
          if (delay > 0) await Bun.sleep(delay);
        }
        if (opts.holdOpenMs && opts.holdOpenMs > 0) await Bun.sleep(opts.holdOpenMs);
        controller.close();
      } catch {
        /* the client aborted; there is nobody left to write to */
      }
    },
  });
}

/** An SSE response over a chunked body. */
export function sseResponse(text: string, opts: StreamOptions = {}): Response {
  return new Response(streamBody(text, opts), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...(opts.headers ?? {}) },
  });
}

/** A JSON response, for the HTTP-error paths. */
export function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/* ------------------------------ canned server ------------------------------ */

export interface CannedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
}

export interface CannedServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly requests: CannedRequest[];
  stop(): void;
}

export type CannedHandler = (req: CannedRequest) => Response | Promise<Response>;

/** A throwaway HTTP server on an ephemeral port that records every request. */
export function startServer(handler: CannedHandler): CannedServer {
  const requests: CannedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const bodyText = await req.text();
      let body: unknown = null;
      try {
        body = bodyText === "" ? null : JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
      const entry: CannedRequest = {
        method: req.method,
        url: req.url,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body,
        bodyText,
      };
      requests.push(entry);
      return handler(entry);
    },
  });
  return {
    port: server.port,
    baseUrl: `http://localhost:${server.port}`,
    requests,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** Run `fn` against a freshly started server and always stop it afterwards. */
export async function withServer<T>(handler: CannedHandler, fn: (server: CannedServer) => Promise<T>): Promise<T> {
  const server = startServer(handler);
  try {
    return await fn(server);
  } finally {
    server.stop();
  }
}

/* --------------------------------- runs --------------------------------- */

/** A request that satisfies the frozen Provider contract. */
export function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "hz-test-model",
    system: "",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A stream being consumed in the background, so a test can act mid-stream. */
export interface Run {
  readonly events: ProviderEvent[];
  readonly done: Promise<void>;
  elapsedMs: number;
  thrown: unknown;
}

/**
 * Consume a provider stream. Failures are captured in `thrown` instead of
 * escaping: “nothing throws at the caller” is part of the contract.
 */
export function run(provider: Provider, req: ProviderRequest): Run {
  const events: ProviderEvent[] = [];
  const started = performance.now();
  const state: Run = {
    events,
    done: Promise.resolve(),
    elapsedMs: 0,
    thrown: null,
  };
  state.done = (async () => {
    try {
      for await (const event of provider.stream(req)) events.push(event);
    } catch (err) {
      state.thrown = err;
    } finally {
      state.elapsedMs = performance.now() - started;
    }
  })();
  return state;
}

/** Wait until `predicate` holds (polling every millisecond). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(1);
  }
}

/** A promise a test resolves at the moment it wants the server to move on. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/* -------------------------------- assertions -------------------------------- */

export function textOf(events: ProviderEvent[]): string {
  return events
    .filter((e): e is Extract<ProviderEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
}

export function toolCallsOf(events: ProviderEvent[]): Array<Extract<ProviderEvent, { type: "tool_call" }>> {
  return events.filter((e): e is Extract<ProviderEvent, { type: "tool_call" }> => e.type === "tool_call");
}

export function lastDone(events: ProviderEvent[]): Extract<ProviderEvent, { type: "done" }> {
  const done = events.filter((e): e is Extract<ProviderEvent, { type: "done" }> => e.type === "done").pop();
  if (!done) throw new Error(`no done event in ${JSON.stringify(events)}`);
  return done;
}

/** JSON.parse that fails the test with the offending string in the message. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`expected a JSON payload, got ${JSON.stringify(raw)}`);
  }
}

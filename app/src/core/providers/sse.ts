/**
 * sse.ts — a small Server-Sent Events reader for the provider streams.
 *
 * Both Anthropic and OpenAI speak SSE over a chunked response body: blocks are
 * separated by a blank line, `data:` lines carry the payload (possibly split
 * across several lines) and comment lines are ignored. No dependencies.
 */

export interface SseMessage {
  /** The `event:` field when the server sent one (Anthropic does). */
  event?: string;
  /** Joined `data:` payload. */
  data: string;
}

function parseBlock(raw: string): SseMessage | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** Iterate the SSE messages of a response body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const message = parseBlock(block);
        if (message) yield message;
        index = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the stream is already closed */
    }
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Abort shows up in a few shapes depending on where the stream was cut. */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function truncate(text: string, max: number): string {
  const value = typeof text === "string" ? text : "";
  return value.length <= max ? value : value.slice(0, max) + "\u2026";
}

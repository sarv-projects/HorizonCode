/**
 * ollama.ts — the Ollama provider (local server, native /api/chat).
 *
 * POST <base>/api/chat with stream:true. The base defaults to
 * http://127.0.0.1:11434 and no key is required; a key is sent as a bearer
 * token only when one is configured (a proxied deployment). The body is NDJSON
 * — one JSON object per line — so this file carries its own line reader; the
 * SSE reader does not apply. Tools use the OpenAI-compatible `tools` field and
 * streamed `message.tool_calls` are assembled by call (the native API sends no
 * ids, and `arguments` may arrive as a complete object or as string
 * fragments). The final line's `done`, `prompt_eval_count` and `eval_count`
 * become the done event and its usage.
 *
 * Failure policy, named: a refused connection is ONE typed error naming the
 * base URL and asking "is ollama running?" — a local server is restarted by
 * the human, and a retry storm only delays the message. An answered 429/5xx
 * still rides the shared bounded backoff and notice. A stream that ends before
 * its final line gets exactly one re-request and then fails typed; the
 * re-request restarts the answer, so text already streamed can repeat (NDJSON
 * carries no delta identity to resume from) and the notice says so. Tool calls
 * are therefore only emitted once the final line arrived, so a dropped pass
 * never leaves half-flushed calls behind.
 *
 * Reduced form, named: no /api/tags model discovery, no keep_alive/num_ctx/
 * images/thinking options (the output cap maps to options.num_predict when the
 * request carries one), and no /v1 OpenAI-compat surface — the native
 * /api/chat endpoint is the one this adapter speaks. A turn that streams two
 * calls to the same function as fragments is assembled as one call unless they
 * arrive as complete objects.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ToolSpec, Usage } from "../../contracts";
import {
  DEFAULT_RETRY_ATTEMPTS,
  backoffDelay,
  delay,
  isRetryableStatus,
  parseRetryAfter,
  retryNotice,
  type RetryInfo,
  type RetryPolicy,
} from "./retry";
import { errorText, isAbortError, truncate } from "./sse";

/** Endpoint root when the settings carry none; config.ts's DEFAULT_BASE_URLS matches. */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** The transport, injectable so a test can drive the parser with no network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OllamaSettings {
  baseUrl?: string;
  /** Optional: only a proxied deployment in front of the server asks for one. */
  apiKey?: string;
  maxTokens?: number;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Request-phase retry tuning; defaults match providers/retry.ts. */
  retry?: Omit<RetryPolicy, "onRetry">;
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

/** Tool-call arguments are a JSON string in the contract and an object on this wire. */
function safeObject(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* unparsable arguments replay as no arguments */
  }
  return {};
}

/**
 * ChatMsg[] -> /api/chat messages. The native API matches a tool result by
 * function name, so a tool message without one cannot be replayed and is
 * skipped (the harness always sets it); assistant calls replay `arguments` as
 * the object the wire expects.
 */
export function toOllamaMessages(messages: ChatMsg[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: msg.content ?? "" });
      continue;
    }
    if (msg.role === "assistant") {
      const entry: OllamaMessage = { role: "assistant", content: typeof msg.content === "string" ? msg.content : "" };
      const calls = msg.toolCalls ?? [];
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({ function: { name: call.name, arguments: safeObject(call.arguments) } }));
      }
      out.push(entry);
      continue;
    }
    if (!msg.toolName) continue; // a name-less result cannot be addressed
    out.push({ role: "tool", content: msg.content && msg.content !== "" ? msg.content : "(no output)", tool_name: msg.toolName });
  }
  return out;
}

/** Tool specs -> the OpenAI-compatible `tools` field the server accepts. */
export function toOllamaTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/** Iterate the NDJSON lines of a response body; a line is one JSON document. */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") yield line;
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail !== "") yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the stream is already closed */
    }
  }
}

/** One pending tool call while its fragments stream in. */
interface PendingCall {
  /** Matching identity: the function name when the wire sent one, else the array position. */
  key: string;
  name: string;
  args: string;
  /** The accumulated args already parse as JSON, so the next fragment starts a new call. */
  complete: boolean;
}

/** One pass over a /api/chat stream, reported through the caller-owned outcome. */
export interface OllamaOutcome {
  /** The final line (`done: true`) was seen: the pass completed. */
  sawDone: boolean;
  /** An error line arrived: terminal, never re-requested. */
  terminal?: boolean;
  /** The signal fired while reading. */
  aborted?: boolean;
  /** `done_reason` from the final line ("length" caps the turn). */
  doneReason?: string;
  usage?: Usage;
  /** Tool calls emitted in this pass. */
  toolCalls: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One pass over one stream. Yields text and tool_call events and records the
 * terminal facts in `outcome`. Per-pass state: fragments from a dropped pass
 * never leak into the re-request's pass.
 */
async function* consumeOllamaStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  outcome: OllamaOutcome,
): AsyncGenerator<ProviderEvent, void, unknown> {
  const pending: PendingCall[] = [];

  /** The newest incomplete entry for `key`, or a fresh one. */
  const openCall = (key: string): PendingCall => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (entry && entry.key === key && !entry.complete) return entry;
    }
    const entry: PendingCall = { key, name: "", args: "", complete: false };
    pending.push(entry);
    return entry;
  };

  for await (const line of readNdjson(body)) {
    if (signal.aborted) {
      outcome.aborted = true;
      return;
    }
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(line) as Record<string, any>;
    } catch {
      // A malformed line is not fatal: name it, then keep reading.
      yield { type: "notice", message: `ollama: skipped a malformed stream line: ${truncate(line, 160)}` };
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.error) {
      yield { type: "error", message: `ollama stream error: ${truncate(String(chunk.error), 400)}` };
      outcome.terminal = true;
      return;
    }

    if (chunk.message && typeof chunk.message === "object") {
      const text = chunk.message.content;
      if (typeof text === "string" && text !== "") yield { type: "text", text };
      const deltas = Array.isArray(chunk.message.tool_calls) ? chunk.message.tool_calls : [];
      deltas.forEach((delta: any, position: number) => {
        const fn = delta?.function ?? {};
        const name = typeof fn.name === "string" ? fn.name : "";
        const raw = fn.arguments;
        if (typeof raw === "string") {
          const entry = openCall(name !== "" ? name : `position:${position}`);
          if (name !== "") entry.name = name;
          entry.args += raw;
          try {
            JSON.parse(entry.args);
            entry.complete = true;
          } catch {
            /* still streaming */
          }
        } else if (raw !== undefined && raw !== null) {
          // A complete argument object: one call, even when the name repeats.
          if (name !== "") pending.push({ key: `call:${pending.length}`, name, args: JSON.stringify(raw), complete: true });
        }
      });
    }

    if (typeof chunk.done === "boolean") {
      outcome.sawDone = chunk.done;
      if (chunk.done) {
        if (typeof chunk.done_reason === "string") outcome.doneReason = chunk.done_reason;
        const input = count(chunk.prompt_eval_count);
        const output = count(chunk.eval_count) ?? count(chunk.completion_count);
        if (input !== undefined || output !== undefined) outcome.usage = { inputTokens: input, outputTokens: output };
      }
    }
  }

  // Tool calls are flushed only on a completed pass, so a dropped pass leaves
  // nothing half-assembled behind (its re-request restarts the answer).
  if (outcome.sawDone) {
    for (const entry of pending) {
      if (entry.name === "") continue;
      outcome.toolCalls += 1;
      yield {
        type: "tool_call",
        id: `call_${outcome.toolCalls}`,
        name: entry.name,
        arguments: entry.args.trim() === "" ? "{}" : entry.args,
      };
    }
  }
}

/**
 * The bounded retry from providers/retry.ts with the transport injected. The
 * one deliberate difference: a connection-level failure is thrown as-is (see
 * the header), so only an answered 429/5xx is retried here.
 */
async function requestOllama(
  transport: FetchLike,
  url: string,
  init: RequestInit,
  policy: Omit<RetryPolicy, "onRetry">,
  onRetry: (info: RetryInfo) => void,
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  for (let attempt = 1; ; attempt += 1) {
    if (init.signal?.aborted === true) throw new Error("aborted before request");
    const response = await transport(url, init);
    if (!isRetryableStatus(response.status) || attempt >= attempts) return response;
    const waitMs = backoffDelay(attempt, {
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
    try {
      await response.body?.cancel();
    } catch {
      /* a body that cannot be cancelled is not a reason to stop retrying */
    }
    onRetry({ attempt, status: response.status, delayMs: waitMs });
    await delay(waitMs, init.signal ?? undefined);
  }
}

/** One typed error naming what a human can fix: start the local server. */
function unreachable(baseUrl: string, err: unknown): string {
  return `ollama request failed: cannot reach ${baseUrl} (is ollama running?): ${errorText(err)}`;
}

async function* streamOllama(settings: OllamaSettings, req: ProviderRequest): AsyncIterable<ProviderEvent> {
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const messages = toOllamaMessages(req.messages ?? []);
  if (typeof req.system === "string" && req.system !== "") messages.unshift({ role: "system", content: req.system });
  if (messages.length === 0) {
    yield { type: "error", message: "ollama: nothing to send (no messages)" };
    return;
  }

  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  const tools = toOllamaTools(req.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  const maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : (settings.maxTokens ?? 0);
  if (maxTokens > 0) body.options = { num_predict: maxTokens };

  const url = `${baseUrl}/api/chat`;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/x-ndjson" };
  if (settings.apiKey && settings.apiKey.trim() !== "") headers.authorization = `Bearer ${settings.apiKey}`;
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body), signal: req.signal };
  const transport: FetchLike = settings.fetch ?? ((target, options) => fetch(target, options));
  const policy = settings.retry ?? {};
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));

  let response: Response;
  const retries: string[] = [];
  try {
    response = await requestOllama(transport, url, init, policy, (info) => retries.push(retryNotice("ollama", info, attempts)));
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: unreachable(baseUrl, err) };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    yield { type: "error", message: `ollama HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}` };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "ollama returned an empty response body" };
    return;
  }

  // Stream phase: a stream that ends before its final line is re-requested
  // exactly once, then the failure is surfaced typed. The notice names the
  // repetition: a re-request replays the answer from the start.
  let retried = false;
  let final: OllamaOutcome | undefined;
  for (;;) {
    const outcome: OllamaOutcome = { sawDone: false, toolCalls: 0 };
    let failure: string | undefined;
    try {
      for await (const event of consumeOllamaStream(response.body, req.signal, outcome)) yield event;
    } catch (err) {
      if (isAbortError(err, req.signal)) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      failure = `ollama stream failed: ${errorText(err)}`;
    }

    if (outcome.aborted || req.signal.aborted) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    if (outcome.terminal) return;
    if (outcome.sawDone) {
      final = outcome;
      break;
    }
    if (failure === undefined) failure = "ollama stream failed: the response ended before its final line";
    if (retried) {
      yield { type: "error", message: failure };
      return;
    }
    retried = true;
    yield { type: "notice", message: "ollama: stream ended before its final line; re-requesting once (earlier text may repeat)" };
    try {
      response = await transport(url, init);
    } catch (err) {
      if (isAbortError(err, req.signal)) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      yield { type: "error", message: unreachable(baseUrl, err) };
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      yield { type: "error", message: `ollama HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}` };
      return;
    }
    if (!response.body) {
      yield { type: "error", message: "ollama returned an empty response body" };
      return;
    }
  }

  let stopReason: "end" | "tool_use" | "max_tokens" = "end";
  if (final?.doneReason === "length") stopReason = "max_tokens";
  if ((final?.toolCalls ?? 0) > 0 && stopReason === "end") stopReason = "tool_use";
  yield { type: "done", stopReason, usage: final?.usage };
}

export function createOllamaProvider(settings: OllamaSettings): Provider {
  return {
    name: "ollama",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> => streamOllama(settings, req),
  };
}

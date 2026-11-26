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
import { extractBase64Images, textFromChatContent } from "../chat-content";
import { maskSecrets } from "../compaction";
import { parseJsonObject } from "../json-repair";
import { classifyProviderFailure } from "./failure-codes";
import { fetchWithRetry } from "./retry";
import { maybeDumpProviderRequest } from "./request-dump";
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
import {
  createProviderDeadline,
  isProviderTimeoutError,
  providerTimeoutEvent,
  readWithIdleTimeout,
  resolveIdleTimeoutMs,
  resolveProviderTimeouts,
  withProviderDeadline,
  type ProviderDeadline,
  type ProviderTimeoutOptions,
} from "./timeout";
import type { MessageFormatter } from "./message-formatter";
import { isCompleteToolArgsObject, toolArgsJson, toolArgsObject } from "./tool-args-object";
import { toolResultContent } from "./tool-result-content";

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
  retry?: Omit<RetryPolicy, "onRetry" | "timeouts">;
  /** Transport timeouts; defaults from HZ_PROVIDER_* (see providers/timeout.ts). */
  timeouts?: ProviderTimeoutOptions;
  /** H-4: optional config-selected formatter; absent → native converter. */
  messageFormatter?: MessageFormatter;
  /** Optional extra request headers (from catalog/provider metadata). */
  headers?: Record<string, string>;
}

export interface ReadNdjsonOptions {
  /** Longest silence between lines; default env/60s, 0 disables. */
  idleTimeoutMs?: number;
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
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
      const images = msg.role === "user" ? extractBase64Images(msg.content) : [];
      out.push({
        role: msg.role,
        content: textFromChatContent(msg.content),
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const entry: OllamaMessage = { role: "assistant", content: typeof msg.content === "string" ? msg.content : "" };
      const calls = msg.toolCalls ?? [];
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({ function: { name: call.name, arguments: toolArgsObject(call.arguments) } }));
      }
      out.push(entry);
      continue;
    }
    if (!msg.toolName) continue; // a name-less result cannot be addressed
    out.push({ role: "tool", content: toolResultContent(msg.content), tool_name: msg.toolName });
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
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  options: ReadNdjsonOptions = {},
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = resolveIdleTimeoutMs(options.idleTimeoutMs);
  const MAX_NDJSON_BUFFER_CHARS = 16 * 1024 * 1024;
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs);
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
      if (buffer.length > MAX_NDJSON_BUFFER_CHARS) {
        throw new Error(`NDJSON stream buffer exceeded maximum size (${MAX_NDJSON_BUFFER_CHARS} chars)`);
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
  idleMs: number,
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

  for await (const line of readNdjson(body, { idleTimeoutMs: idleMs })) {
    if (signal.aborted) {
      outcome.aborted = true;
      return;
    }
    // H-5: strict NDJSON line parse via a single-purpose util (no inline parse
    // in this loop); a malformed line is named, then reading continues.
    const chunk = parseJsonObject(line);
    if (chunk === undefined) {
      yield { type: "notice", message: `ollama: skipped a malformed stream line: ${truncate(line, 160)}` };
      continue;
    }
    if (chunk.error) {
      const errText = truncate(String(chunk.error), 400);
      yield { type: "error", message: `ollama stream error: ${errText}`, code: classifyProviderFailure(0, errText) };
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
          // H-5: completeness check via the util, never inline JSON.parse.
          if (isCompleteToolArgsObject(entry.args)) entry.complete = true;
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
        // H-5: normalize any arg shape (object, string, malformed / truncated
        // tail) through the util; a cut-off blob fails closed to "{}".
        arguments: toolArgsJson(entry.args),
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
  requestTimeoutMs: number,
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  for (let attempt = 1; ; attempt += 1) {
    if (init.signal?.aborted) throw new Error("aborted before request");
    const attemptDeadline = createProviderDeadline(init.signal ?? undefined, { requestMs: requestTimeoutMs, totalMs: 0 });
    let response: Response;
    try {
      response = await transport(url, { ...init, signal: attemptDeadline.signal });
    } catch (err) {
      const timeout = attemptDeadline.timedOut();
      attemptDeadline.dispose();
      throw timeout ?? err;
    }
    attemptDeadline.headersReceived();
    attemptDeadline.dispose();
    const lateTimeout = attemptDeadline.timedOut();
    if (lateTimeout) {
      try {
        await response.body?.cancel();
      } catch {
        /* the body is already gone */
      }
      throw lateTimeout;
    }
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

async function* streamOllama(
  settings: OllamaSettings,
  req: ProviderRequest,
  deadline: ProviderDeadline,
): AsyncIterable<ProviderEvent> {
  const timeouts = resolveProviderTimeouts(settings.timeouts);
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  // H-4: render through the config-selected formatter when one was supplied.
  const messages: unknown[] = settings.messageFormatter
    ? [...settings.messageFormatter.formatMessages(req.messages ?? [])]
    : toOllamaMessages(req.messages ?? []);
  if (typeof req.system === "string" && req.system !== "") messages.unshift({ role: "system", content: req.system });
  if (messages.length === 0) {
    yield { type: "error", message: "ollama: nothing to send (no messages)", code: "UNKNOWN" };
    return;
  }

  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  const tools = toOllamaTools(req.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  const maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : (settings.maxTokens ?? 0);
  if (maxTokens > 0) body.options = { num_predict: maxTokens };
  await maybeDumpProviderRequest("ollama", body);

  const url = `${baseUrl}/api/chat`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  headers["content-type"] = "application/json";
  headers.accept = "application/x-ndjson";
  if (settings.apiKey && settings.apiKey.trim() !== "") headers.authorization = `Bearer ${settings.apiKey}`;
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body), signal: deadline.signal };
  const transport: FetchLike = settings.fetch ?? ((target, options) => fetch(target, options));
  const policy = settings.retry ?? {};
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));

  let response: Response;
  const retries: string[] = [];
  try {
    response = await fetchWithRetry(url, init, {
      ...policy,
      fetch: transport,
      timeouts: { requestMs: timeouts.requestMs, totalMs: timeouts.totalMs },
      breakerRoute: `ollama@${baseUrl}`,
      shouldRetryError: (err) =>
        !/ECONNREFUSED|ConnectionRefused|Unable to connect/i.test(
          err instanceof Error
            ? `${err.name} ${err.message} ${(err as NodeJS.ErrnoException).code ?? ""}`
            : String(err),
        ),
      onRetry: (info) => retries.push(retryNotice("ollama", info, attempts)),
    });
    deadline.headersReceived();
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent("ollama", timeout, "request");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: unreachable(baseUrl, err), code: "TRANSIENT" };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = maskSecrets(await response.text().catch(() => ""));
    const expired = deadline.timedOut();
    if (expired) {
      yield providerTimeoutEvent("ollama", expired, "request");
      return;
    }
    const code = classifyProviderFailure(response.status, detail);
    yield {
      type: "error",
      message: `ollama HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}`,
      code,
    };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "ollama returned an empty response body", code: "EMPTY_RESPONSE" };
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
      for await (const event of consumeOllamaStream(response.body, req.signal, outcome, timeouts.idleMs)) yield event;
    } catch (err) {
      const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
      if (timeout) {
        yield providerTimeoutEvent("ollama", timeout, "stream");
        return;
      }
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
      yield { type: "error", message: failure, code: "TRANSIENT" };
      return;
    }
    retried = true;
    yield { type: "notice", message: "ollama: stream ended before its final line; re-requesting once (earlier text may repeat)" };
    try {
      response = await requestOllama(transport, url, init, { ...policy, attempts: 1 }, () => undefined, timeouts.requestMs);
      deadline.headersReceived();
    } catch (err) {
      const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
      if (timeout) {
        yield providerTimeoutEvent("ollama", timeout, "request");
        return;
      }
      if (isAbortError(err, req.signal)) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      yield { type: "error", message: unreachable(baseUrl, err), code: "TRANSIENT" };
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const expired = deadline.timedOut();
      if (expired) {
        yield providerTimeoutEvent("ollama", expired, "request");
        return;
      }
      const code = classifyProviderFailure(response.status, detail);
      yield {
        type: "error",
        message: `ollama HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}`,
        code,
      };
      return;
    }
    if (!response.body) {
      yield { type: "error", message: "ollama returned an empty response body", code: "EMPTY_RESPONSE" };
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
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
      withProviderDeadline(req.signal, settings.timeouts ?? {}, (deadline) => streamOllama(settings, req, deadline)),
  };
}

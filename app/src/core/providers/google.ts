/**
 * google.ts — the Gemini provider (generativelanguage v1beta REST).
 *
 * POST <base>/v1beta/models/<model>:streamGenerateContent?alt=sse with the key
 * in the `x-goog-api-key` header, and translate the SSE `data:` frames into the
 * provider contract: text chunks, complete function calls, one done carrying
 * the finish reason and the usage metadata. Errors become an {type:'error'}
 * event and an abort becomes done/abort; nothing here throws at the caller.
 *
 * Mapping: the system prompt -> systemInstruction; conversation turns ->
 * contents (user/model); tool results -> functionResponse parts in a user turn;
 * tool specs -> tools[].functionDeclarations. Gemini streams whole parts, not
 * fragments, so a functionCall part is emitted as it arrives.
 *
 * Reduced form, named: no inline file/PDF parts, no cachedContent, no thinking
 * config (and `thought: true` parts are dropped rather than shown as text), no
 * thought-signature echo, no explicit safetySettings, and no parallel-call
 * bookkeeping beyond arrival order. A functionCall that carries no id gets a
 * synthesized `call_<n>` — this path does not send call ids back, and a
 * replayed functionResponse matches on the function name, not the id.
 *
 * The request phase mirrors providers/retry.ts with the transport injected:
 * a 429/5xx or a connection failure rides the same bounded backoff and notice
 * the other adapters use (retry.ts itself always calls the global fetch, which
 * an offline test cannot replace without a socket).
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../contracts";
import { parseJsonObject } from "../json-repair";
import { classifyProviderFailure } from "./failure-codes";
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
import { errorText, isAbortError, readSse, truncate } from "./sse";
import {
  createProviderDeadline,
  isProviderTimeoutError,
  providerTimeoutEvent,
  resolveProviderTimeouts,
  withProviderDeadline,
  type ProviderDeadline,
  type ProviderTimeoutOptions,
} from "./timeout";
import type { MessageFormatter } from "./message-formatter";
import { toolArgsJson, toolArgsObject } from "./tool-args-object";
import { toolResultContent } from "./tool-result-content";

/** Endpoint root when the settings carry none; config.ts's DEFAULT_BASE_URLS matches. */
export const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";

/** The transport, injectable so a test can drive the parser with no network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleSettings {
  apiKey: string;
  baseUrl?: string;
  /** Output cap when the request carries none; absent leaves it to the model. */
  maxTokens?: number;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Request-phase retry tuning; defaults match providers/retry.ts. */
  retry?: Omit<RetryPolicy, "onRetry" | "timeouts">;
  /** Transport timeouts; defaults from HZ_PROVIDER_* (see providers/timeout.ts). */
  timeouts?: ProviderTimeoutOptions;
  /** H-4: optional config-selected formatter; absent → native converter. */
  messageFormatter?: MessageFormatter;
}

type GooglePart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

/**
 * ChatMsg[] -> Google contents. Consecutive same-role turns are merged (the API
 * accepts repeats, but merging keeps one content per turn), the system prompt
 * is delivered separately as systemInstruction, and a tool result becomes a
 * user-role functionResponse addressed by function name.
 */
export function toGoogleContents(messages: ChatMsg[]): GoogleContent[] {
  const out: GoogleContent[] = [];
  const callNames = new Map<string, string>();
  const push = (role: "user" | "model", parts: GooglePart[]): void => {
    if (parts.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") continue; // delivered as the top-level systemInstruction
    if (msg.role === "user") {
      if (typeof msg.content === "string" && msg.content !== "") push("user", [{ text: msg.content }]);
      continue;
    }
    if (msg.role === "assistant") {
      const parts: GooglePart[] = [];
      if (typeof msg.content === "string" && msg.content.trim() !== "") parts.push({ text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        callNames.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: toolArgsObject(call.arguments) } });
      }
      push("model", parts);
      continue;
    }
    // tool result: the API matches it by function name
    const name =
      (msg.toolName && msg.toolName !== "" ? msg.toolName : undefined) ??
      (msg.toolCallId ? callNames.get(msg.toolCallId) : undefined);
    if (!name) continue; // without a name the response cannot be addressed
    push("user", [
      { functionResponse: { name, response: { result: toolResultContent(msg.content) } } },
    ]);
  }
  return out;
}

/** Tool specs -> the single `tools[]` entry Gemini expects. Empty stays empty. */
export function toGoogleTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  const declarations = (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
  if (declarations.length === 0) return [];
  return [{ functionDeclarations: declarations }];
}

function mapFinishReason(reason: unknown): "end" | "max_tokens" {
  return reason === "MAX_TOKENS" ? "max_tokens" : "end";
}

/**
 * providers/retry.ts with the transport injected. Semantics are that file's
 * own: only the window before response headers is retried, `Retry-After` wins
 * over the backoff, and an abort throws at once.
 */
async function requestWithRetry(
  transport: FetchLike,
  url: string,
  init: RequestInit,
  policy: Omit<RetryPolicy, "onRetry">,
  onRetry: (info: RetryInfo) => void,
  requestTimeoutMs: number,
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  const signal = init.signal ?? undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted === true) throw lastError ?? new Error("aborted before request");
    // One headers budget per attempt; the caller's signal (which already
    // carries the total deadline) is merged in below.
    const attemptDeadline = createProviderDeadline(signal, { requestMs: requestTimeoutMs, totalMs: 0 });
    try {
      const response = await transport(url, { ...init, signal: attemptDeadline.signal });
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
      // Release the failed response before waiting, or an unread body holds the
      // connection open for the whole backoff.
      try {
        await response.body?.cancel();
      } catch {
        /* a body that cannot be cancelled is not a reason to stop retrying */
      }
      onRetry({ attempt, status: response.status, delayMs: waitMs });
      await delay(waitMs, signal);
    } catch (err) {
      attemptDeadline.dispose();
      const timedOut = attemptDeadline.timedOut();
      lastError = timedOut ?? err;
      if (signal?.aborted || attempt >= attempts) throw lastError;
      const waitMs = backoffDelay(attempt, { baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs, retryAfterMs: null });
      onRetry({ attempt, error: lastError, delayMs: waitMs });
      await delay(waitMs, signal);
    }
  }
  throw lastError ?? new Error("request failed after retries");
}

async function* streamGoogle(
  settings: GoogleSettings,
  req: ProviderRequest,
  deadline: ProviderDeadline,
): AsyncIterable<ProviderEvent> {
  const timeouts = resolveProviderTimeouts(settings.timeouts);
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : DEFAULT_GOOGLE_BASE_URL).replace(/\/+$/, "");
  // H-4: render through the config-selected formatter when one was supplied.
  const contents: readonly unknown[] = settings.messageFormatter
    ? settings.messageFormatter.formatMessages(req.messages ?? [])
    : toGoogleContents(req.messages ?? []);
  if (contents.length === 0) {
    yield { type: "error", message: "google: nothing to send (no messages)", code: "UNKNOWN" };
    return;
  }

  // HZ_MODEL may name the resource path form (`models/gemini-…`); the URL below
  // adds `models/` itself, so drop a leading prefix rather than double it.
  const model = String(req.model ?? "").replace(/^models\//, "");
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  const body: Record<string, unknown> = { contents };
  if (typeof req.system === "string" && req.system !== "") {
    body.systemInstruction = { parts: [{ text: req.system }] };
  }
  const tools = toGoogleTools(req.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  const maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : (settings.maxTokens ?? 0);
  if (maxTokens > 0) body.generationConfig = { maxOutputTokens: maxTokens };

  const transport: FetchLike = settings.fetch ?? ((target, init) => fetch(target, init));
  const policy = settings.retry ?? {};
  const attempts = Math.max(1, Math.floor(policy.attempts ?? DEFAULT_RETRY_ATTEMPTS));

  let response: Response;
  const retries: string[] = [];
  try {
    response = await requestWithRetry(
      transport,
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": settings.apiKey,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      },
      policy,
      (info) => retries.push(retryNotice("google", info, attempts)),
      timeouts.requestMs,
    );
    deadline.headersReceived();
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent("google", timeout, "request");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `google request failed: ${errorText(err)}`, code: "TRANSIENT" };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const expired = deadline.timedOut();
    if (expired) {
      yield providerTimeoutEvent("google", expired, "request");
      return;
    }
    const code = classifyProviderFailure(response.status, detail);
    yield {
      type: "error",
      message: `google HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}`,
      code,
    };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "google returned an empty response body", code: "EMPTY_RESPONSE" };
    return;
  }

  let finish: unknown;
  let aborted = false;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let emittedTool = false;
  let calls = 0;

  try {
    for await (const message of readSse(response.body, { idleTimeoutMs: timeouts.idleMs })) {
      if (req.signal.aborted) {
        aborted = true;
        break;
      }
      if (message.data === "[DONE]") break; // not sent by Gemini; tolerated for gateways that add it
      // H-5: strict frame parse via a single-purpose util (no inline parse in
      // this loop); a malformed frame is named, then reading continues.
      const event = parseJsonObject(message.data);
      if (event === undefined) {
        yield { type: "notice", message: `google: skipped a malformed stream frame: ${truncate(message.data.replace(/\s+/g, " ").trim(), 160)}` };
        continue;
      }
      if (event.error) {
        const text = typeof event.error.message === "string" ? event.error.message : "google stream error";
        yield { type: "error", message: text, code: classifyProviderFailure(0, text) };
        return;
      }
      const blocked = event.promptFeedback?.blockReason;
      if (typeof blocked === "string" && blocked !== "") {
        yield { type: "error", message: `google blocked the prompt (${blocked})`, code: "AUTH" };
        return;
      }
      if (event.usageMetadata && typeof event.usageMetadata === "object") {
        const meta = event.usageMetadata as Record<string, unknown>;
        if (typeof meta.promptTokenCount === "number") usage = { ...(usage ?? {}), inputTokens: meta.promptTokenCount };
        if (typeof meta.candidatesTokenCount === "number") usage = { ...(usage ?? {}), outputTokens: meta.candidatesTokenCount };
      }
      const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
      if (!candidate) continue;
      if (candidate.finishReason) finish = candidate.finishReason;
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.thought === true) continue; // reasoning is not assistant text on this wire
        if (typeof part.text === "string" && part.text !== "") yield { type: "text", text: part.text };
        const call = part.functionCall;
        if (call && typeof call.name === "string" && call.name !== "") {
          calls += 1;
          emittedTool = true;
          const id = typeof call.id === "string" && call.id !== "" ? call.id : `call_${calls}`;
          // H-5: normalize any wire arg shape (object, JSON string, malformed /
          // truncated tail) through the util; fail closed to "{}".
          yield { type: "tool_call", id, name: call.name, arguments: toolArgsJson(call.args) };
        }
      }
    }
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent("google", timeout, "stream");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `google stream failed: ${errorText(err)}`, code: "TRANSIENT" };
    return;
  }

  if (aborted || req.signal.aborted) {
    yield { type: "done", stopReason: "abort" };
    return;
  }

  let stopReason: "end" | "tool_use" | "max_tokens" = mapFinishReason(finish);
  if (emittedTool && stopReason === "end") stopReason = "tool_use";
  yield { type: "done", stopReason, usage };
}

export function createGoogleProvider(settings: GoogleSettings): Provider {
  return {
    name: "google",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
      withProviderDeadline(req.signal, settings.timeouts ?? {}, (deadline) => streamGoogle(settings, req, deadline)),
  };
}

/**
 * openai.ts — the OpenAI (chat completions) provider.
 *
 * POST <baseUrl>/v1/chat/completions with stream:true. Tool call deltas are
 * assembled by index, then emitted as complete tool calls before the done event
 * that carries the finish reason.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ToolSpec, Usage } from "../../contracts";
import { parseJsonObject } from "../json-repair";
import type { MessageFormatter } from "./message-formatter";
import { mapOpenAiUsage } from "./openai-usage";
import { applyQuirks } from "./quirks";
import { systemPromptUpdateInHistory, wireSystemPromptInHistory } from "../system-prompt-wire";
import { maybeDumpProviderRequest } from "./request-dump";
import { textFromOpenAiDeltaContent } from "./openai-delta-content";
import { toolResultContent } from "./tool-result-content";
import { classifyProviderFailure } from "./failure-codes";
import { DEFAULT_RETRY_ATTEMPTS, fetchWithRetry, retryNotice, type RetryPolicy } from "./retry";
import { errorText, isAbortError, readSse, truncate } from "./sse";
import {
  isProviderTimeoutError,
  providerTimeoutEvent,
  resolveProviderTimeouts,
  withProviderDeadline,
  type ProviderDeadline,
  type ProviderTimeoutOptions,
} from "./timeout";
import {
  formatAssemblyCancelNotice,
  toolInputErrorEvent,
  ToolCallAssembler,
  validateFinalToolArguments,
} from "./tool-call-assembly";

export interface OpenAiSettings {
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Transport timeouts; defaults from HZ_PROVIDER_* (see providers/timeout.ts). */
  timeouts?: ProviderTimeoutOptions;
  /** Request-phase retry tuning; defaults match providers/retry.ts. */
  retry?: Omit<RetryPolicy, "onRetry" | "timeouts">;
  /**
   * H-4: formatter selected from config `formatMessageClass`. When absent the
   * native `toOpenAiMessages` converter is used (byte-identical default).
   */
  messageFormatter?: MessageFormatter;
}

/**
 * The provider-agnostic settings the wire core actually needs. `name` labels
 * the notices/errors (so a compatible host reads as itself, e.g. "groq", not
 * "openai"); `authorization` is the complete header value (`Bearer <key>`) or
 * `undefined` for a keyless host. The generic openai-compatible adapter reuses
 * this exact core — it does not clone the SSE loop.
 */
export interface OpenAiWireSettings {
  /** The provider id used in notices and error messages. */
  name: string;
  baseUrl?: string;
  maxTokens?: number;
  /** The full Authorization header value, or `undefined` for a keyless host. */
  authorization?: string;
  /** When set, used on each attempt (e.g. after oauth refresh). */
  getAuthorization?: () => string | undefined;
  /** On HTTP 401, return true when credentials were refreshed and the request may be retried once. */
  onUnauthorized?: () => Promise<boolean>;
  /** Transport timeouts; defaults from HZ_PROVIDER_* (see providers/timeout.ts). */
  timeouts?: ProviderTimeoutOptions;
  /** Request-phase retry tuning; defaults match providers/retry.ts. */
  retry?: Omit<RetryPolicy, "onRetry" | "timeouts">;
  /** H-4: optional config-selected formatter; absent → native converter. */
  messageFormatter?: MessageFormatter;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MAX_TOKENS = 4096;

/** ChatMsg[] -> OpenAI chat messages, tool calls and tool results included. */
export function toOpenAiMessages(messages: ChatMsg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: msg.content ?? "" });
      continue;
    }
    if (msg.role === "assistant") {
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: typeof msg.content === "string" && msg.content !== "" ? msg.content : null,
      };
      const calls = msg.toolCalls ?? [];
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments && call.arguments !== "" ? call.arguments : "{}" },
        }));
      }
      out.push(entry);
      continue;
    }
    if (!msg.toolCallId) continue; // a tool message without its id cannot be replayed
    const toolEntry: Record<string, unknown> = {
      role: "tool",
      tool_call_id: msg.toolCallId,
      content: toolResultContent(msg.content),
    };
    if (msg.toolName) toolEntry.name = msg.toolName;
    out.push(toolEntry);
  }
  return out;
}

export function toOpenAiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function mapFinishReason(reason: unknown): "end" | "tool_use" | "max_tokens" {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end";
}

/**
 * The OpenAI chat-completions wire core, parameterized purely by data
 * (`name` / `baseUrl` / `authorization`). The `openai` provider and the generic
 * `openai-compatible` adapter both stream through this one function — there is
 * no second SSE loop, tool-call assembler, finish-reason map or retry policy.
 */
/** OpenAI-compatible chat URL: accepts roots with or without a trailing `/v1`. */
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  if (root.endsWith("/v1")) return `${root}/chat/completions`;
  return `${root}/v1/chat/completions`;
}

export function streamOpenAiCompatible(
  settings: OpenAiWireSettings,
  req: ProviderRequest,
): AsyncIterable<ProviderEvent> {
  return withProviderDeadline(req.signal, settings.timeouts ?? {}, (deadline) =>
    streamOpenAiCompatibleInner(settings, req, deadline),
  );
}

async function* streamOpenAiCompatibleInner(
  settings: OpenAiWireSettings,
  req: ProviderRequest,
  deadline: ProviderDeadline,
): AsyncGenerator<ProviderEvent, void, unknown> {
  const name = settings.name;
  const timeouts = resolveProviderTimeouts(settings.timeouts);
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, "");
  const wire = systemPromptUpdateInHistory() ? wireSystemPromptInHistory(req) : req;
  // H-4: render through the config-selected formatter when one was supplied;
  // the default path is the byte-identical native converter.
  const messages: readonly unknown[] = settings.messageFormatter
    ? settings.messageFormatter.formatMessages(wire.messages ?? [])
    : toOpenAiMessages(wire.messages ?? []);
  if (messages.length === 0) {
    yield { type: "error", message: `${name}: nothing to send (no messages)`, code: "UNKNOWN" };
    return;
  }

  const body: Record<string, unknown> = {
    model: wire.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof wire.system === "string" && wire.system !== "") {
    body.messages = [{ role: "system", content: wire.system }, ...messages];
  }
  if (Array.isArray(wire.tools) && wire.tools.length > 0) body.tools = toOpenAiTools(wire.tools);
  if (wire.maxTokens && wire.maxTokens > 0) body.max_tokens = wire.maxTokens;
  else if (settings.maxTokens && settings.maxTokens > 0) body.max_tokens = settings.maxTokens;
  else body.max_tokens = DEFAULT_MAX_TOKENS;
  if (typeof wire.reasoningEffort === "string" && wire.reasoningEffort.trim() !== "") {
    body.reasoning_effort = wire.reasoningEffort.trim();
  }

  const quirksApplied = applyQuirks({ provider: name, model: wire.model, baseUrl }, body);
  if (quirksApplied.length > 0) yield { type: "quirks", applied: quirksApplied };
  maybeDumpProviderRequest(name, body);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  // A keyless host (Credential kind "none") gets no Authorization header; the
  // header is data, never derived from the provider id.
  const authHeader = settings.getAuthorization?.() ?? settings.authorization;
  if (authHeader && authHeader.trim() !== "") headers.authorization = authHeader;

  let response: Response;
  const retries: string[] = [];
  const retryAttempts = Math.max(1, Math.floor(settings.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  const post = () =>
    fetchWithRetry(
      openAiChatCompletionsUrl(baseUrl),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: deadline.signal,
      },
      {
        ...settings.retry,
        // Headers per attempt and a total cap for the request phase; the idle
        // guard on the body is applied by readSse below.
        timeouts: { requestMs: timeouts.requestMs, totalMs: timeouts.totalMs },
        // Ride out a rate limit or an overloaded upstream instead of failing the
        // whole turn; the notices below keep it visible rather than silent.
        onRetry: (info) => retries.push(retryNotice(name, info, retryAttempts)),
      },
    );
  try {
    response = await post();
    deadline.headersReceived();
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent(name, timeout, "request");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `${name} request failed: ${errorText(err)}`, code: "TRANSIENT" };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (response.status === 401 && settings.onUnauthorized) {
    const refreshed = await settings.onUnauthorized();
    if (refreshed) {
      const nextAuth = settings.getAuthorization?.() ?? settings.authorization;
      if (nextAuth && nextAuth.trim() !== "") headers.authorization = nextAuth;
      else delete headers.authorization;
      try {
        response = await fetchWithRetry(
          openAiChatCompletionsUrl(baseUrl),
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: deadline.signal,
          },
          {
            attempts: 1,
            timeouts: { requestMs: timeouts.requestMs, totalMs: 0 },
          },
        );
        deadline.headersReceived();
      } catch (err) {
        const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
        if (timeout) {
          yield providerTimeoutEvent(name, timeout, "request");
          return;
        }
        if (isAbortError(err, req.signal)) {
          yield { type: "done", stopReason: "abort" };
          return;
        }
        yield { type: "error", message: `${name} request failed: ${errorText(err)}`, code: "TRANSIENT" };
        return;
      }
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const expired = deadline.timedOut();
    if (expired) {
      yield providerTimeoutEvent(name, expired, "request");
      return;
    }
    const code = classifyProviderFailure(response.status, detail);
    yield {
      type: "error",
      message: `${name} HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}`,
      code,
    };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: `${name} returned an empty response body`, code: "EMPTY_RESPONSE" };
    return;
  }

  let finish: unknown;
  let aborted = false;
  let usage: Usage | undefined;
  const assembler = new ToolCallAssembler();

  const yieldAssemblyCancel = function* (): Generator<ProviderEvent, void, unknown> {
    const cancelled = assembler.cancel();
    if (cancelled.length > 0) {
      yield { type: "notice", message: formatAssemblyCancelNotice(cancelled) };
    }
  };

  try {
    for await (const message of readSse(response.body, { idleTimeoutMs: timeouts.idleMs })) {
      if (req.signal?.aborted) {
        aborted = true;
        break;
      }
      if (message.data === "[DONE]") break;
      // H-5: strict frame parse lives in a single-purpose util, never inline
      // in the SSE loop (usage/reasoning parsing below is unchanged).
      const event = parseJsonObject(message.data);
      if (event === undefined) continue;
      if (event.error) {
        const text = typeof event.error.message === "string" ? event.error.message : `${name} stream error`;
        yield { type: "error", message: text };
        return;
      }
      // Full OpenAI-compatible usage decode (opencode mapUsage), including the
      // Moonshot `choice.usage` dialect. Top-level usage wins when both exist.
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      const choiceUsage = choice !== null && typeof choice === "object" ? (choice as Record<string, unknown>).usage : undefined;
      const decoded = mapOpenAiUsage(event.usage) ?? mapOpenAiUsage(choiceUsage);
      if (decoded) usage = decoded;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoning !== "") yield { type: "thinking", text: reasoning };
      const text = textFromOpenAiDeltaContent(delta.content);
      if (text !== "") yield { type: "text", text };
      const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of deltas) {
        assembler.pushDelta(call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      // Never flush partial argument JSON after a cut stream.
      yield* yieldAssemblyCancel();
      yield providerTimeoutEvent(name, timeout, "stream");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield* yieldAssemblyCancel();
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `${name} stream failed: ${errorText(err)}` };
    return;
  }

  if (aborted || req.signal?.aborted) {
    // C-9 assembly-cancel: never flush partial argument JSON after steer/abort.
    yield* yieldAssemblyCancel();
    yield { type: "done", stopReason: "abort" };
    return;
  }

  const completed = assembler.flushCompleted();
  let emittedCallCount = 0;
  for (const call of completed) {
    // H-5: validate FINAL assembled argument JSON outside the SSE loop. Syntax-
    // only repair is admitted; an unrepairable / truncated blob is refused with
    // a structured tool_input_error rather than fed downstream as broken JSON.
    const validated = validateFinalToolArguments(call);
    if (validated.ok === false) {
      yield toolInputErrorEvent(validated.refusal);
      continue;
    }
    emittedCallCount += 1;
    yield {
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: validated.arguments,
    };
  }

  let stopReason = mapFinishReason(finish);
  if (emittedCallCount > 0 && stopReason === "end") stopReason = "tool_use";
  yield { type: "done", stopReason, usage };
}

export function createOpenAiProvider(settings: OpenAiSettings): Provider {
  return {
    name: "openai",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
      streamOpenAiCompatible(
        {
          name: "openai",
          baseUrl: settings.baseUrl,
          maxTokens: settings.maxTokens,
          authorization: `Bearer ${settings.apiKey}`,
          timeouts: settings.timeouts,
          retry: settings.retry,
          messageFormatter: settings.messageFormatter,
        },
        req,
      ),
  };
}

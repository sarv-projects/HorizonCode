/**
 * anthropic.ts — the Claude provider.
 *
 * POST <baseUrl>/v1/messages with stream:true and translate the SSE events into
 * the provider contract: text deltas, complete tool calls, one done with the
 * stop reason. Errors become an {type:'error'} event; an abort becomes
 * done/abort. Nothing here throws at the caller.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ThinkingEcho, ToolCall, ToolSpec } from "../../contracts";
import { wireAnthropicContentBlocks, wireAnthropicToolResultContent } from "../chat-content";
import { anthropicSystemField } from "./anthropic-cache";
import { applyAnthropicRequestCacheBreakpoints } from "./anthropic-cache-wire";
import { anthropicToolArguments, anthropicToolInput } from "./anthropic-tool-args";
import { formatObservationMessages, NO_TOOL_OUTPUT, toolResultContent, toolResultIsMultipart } from "./tool-result-content";
import type { MessageFormatter } from "./message-formatter";
import { finalizeAssembledToolCall, toolInputErrorEvent, validateFinalToolArguments } from "./tool-call-assembly";
import { parseJsonObject } from "../json-repair";
import { systemPromptUpdateInHistory, wireSystemPromptInHistory } from "../system-prompt-wire";
import { classifyProviderFailure } from "./failure-codes";
import { maybeDumpProviderRequest } from "./request-dump";
import { DEFAULT_RETRY_ATTEMPTS, fetchWithRetry, retryNotice, type RetryPolicy } from "./retry";
import { maskSecrets } from "../compaction";
import { errorText, isAbortError, readSse, truncate } from "./sse";
import {
  isProviderTimeoutError,
  providerTimeoutEvent,
  resolveProviderTimeouts,
  withProviderDeadline,
  type ProviderDeadline,
  type ProviderTimeoutOptions,
} from "./timeout";

export interface AnthropicSettings {
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Transport timeouts; defaults from HZ_PROVIDER_* (see providers/timeout.ts). */
  timeouts?: ProviderTimeoutOptions;
  /** Request-phase retry tuning; defaults match providers/retry.ts. */
  retry?: Omit<RetryPolicy, "onRetry" | "timeouts">;
  /**
   * H-4: formatter selected from config `formatMessageClass`. When absent the
   * native `toAnthropicMessages` converter is used (byte-identical default);
   * when set, the resolved dialect renders messages and observations.
   */
  messageFormatter?: MessageFormatter;
  /** Optional extra request headers (from catalog/provider metadata). */
  headers?: Record<string, string>;
}

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content:
        | string
        | Array<{ type: "text"; text: string } | { type: "image"; source: Record<string, unknown> }>;
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

/**
 * ChatMsg[] -> Anthropic messages. Consecutive same-role messages are merged
 * because the API wants alternating turns, and tool results are user turns.
 *
 * H-4: when a config-selected `formatter` is supplied, every non-observation
 * message is rendered through `format_message` and tool results through the
 * formatter's `format_observation_messages` hook. With no formatter (the
 * default) the native path below is byte-identical to the historic converter.
 */
export function toAnthropicMessages(messages: ChatMsg[], formatter?: MessageFormatter): AnthropicMessage[] {
  if (formatter !== undefined) {
    const out: AnthropicMessage[] = [];
    for (const msg of messages) {
      if (!msg) continue;
      if (msg.role === "tool") {
        const wire = formatObservationMessages(formatter, [msg]);
        if (wire !== undefined) out.push(...(wire as AnthropicMessage[]));
        continue;
      }
      out.push(...(formatter.formatMessages([msg]) as AnthropicMessage[]));
    }
    return out;
  }

  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") continue; // delivered as the top-level system prompt
    if (msg.role === "user") {
      const blocks = wireAnthropicContentBlocks(msg.content) as AnthropicBlock[];
      push("user", blocks.length > 0 ? blocks : [{ type: "text", text: "" }]);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      // ADDITIVE (signed thinking replay): Anthropic requires a signed thinking
      // block to be echoed back verbatim on the next turn. Without a signature
      // there is nothing valid to replay, so older display-only history is
      // byte-for-byte unchanged.
      if (msg.thinkingSignature && msg.thinking) {
        blocks.push({ type: "thinking", thinking: msg.thinking, signature: msg.thinkingSignature });
      }
      if (msg.redactedThinking) blocks.push({ type: "redacted_thinking", data: msg.redactedThinking });
      if (typeof msg.content === "string" && msg.content.trim() !== "") blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: anthropicToolInput(call.arguments) });
      }
      push("assistant", blocks);
      continue;
    }
    // tool result
    if (!msg.toolCallId) continue; // unusable without the id it answers
    const toolBody = toolResultIsMultipart(msg.content)
      ? wireAnthropicToolResultContent(msg.content)
      : toolResultContent(msg.content);
    const normalizedToolBody =
      typeof toolBody === "string" ? (toolBody !== "" ? toolBody : NO_TOOL_OUTPUT) : toolBody.length > 0 ? toolBody : NO_TOOL_OUTPUT;
    push("user", [{ type: "tool_result", tool_use_id: msg.toolCallId, content: normalizedToolBody }]);
  }
  return out;
}

export function toAnthropicTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  }));
}

function mapStopReason(reason: unknown): "end" | "tool_use" | "max_tokens" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

interface UsageShape {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  nonCachedInputTokens?: number;
}

async function* streamAnthropic(
  settings: AnthropicSettings,
  req: ProviderRequest,
  deadline: ProviderDeadline,
): AsyncIterable<ProviderEvent> {
  const timeouts = resolveProviderTimeouts(settings.timeouts);
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : "https://api.anthropic.com").replace(/\/+$/, "");
  const wire = systemPromptUpdateInHistory() ? wireSystemPromptInHistory(req) : req;
  // H-4: render through the config-selected formatter when one was supplied;
  // the default path is the byte-identical native converter.
  let messages = toAnthropicMessages(wire.messages ?? [], settings.messageFormatter);
  if (messages.length === 0) {
    yield { type: "error", message: "anthropic: nothing to send (no messages after system)", code: "UNKNOWN" };
    return;
  }

  const systemField =
    typeof wire.system === "string" && wire.system !== "" ? anthropicSystemField(wire.system) : undefined;
  const cached = applyAnthropicRequestCacheBreakpoints(
    systemField,
    messages as unknown as import("./anthropic-cache-wire").AnthropicWireMessage[],
  );
  // Cache markers are additive `cache_control` fields; block shapes stay AnthropicBlock.
  messages = cached.messages as unknown as AnthropicMessage[];

  const body: Record<string, unknown> = {
    model: wire.model,
    max_tokens: wire.maxTokens && wire.maxTokens > 0 ? wire.maxTokens : (settings.maxTokens ?? DEFAULT_MAX_TOKENS),
    messages,
    stream: true,
  };
  if (cached.system !== undefined && cached.system !== "") body.system = cached.system;
  if (Array.isArray(wire.tools) && wire.tools.length > 0) {
    body.tools = toAnthropicTools(wire.tools);
    if (wire.toolChoice === "none") body.tool_choice = { type: "none" };
    else if (wire.toolChoice === "auto") body.tool_choice = { type: "auto" };
    else if (wire.toolChoice === "required") body.tool_choice = { type: "any" };
  }
  await maybeDumpProviderRequest("anthropic", body);

  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.headers ?? {})) {
    normalizedHeaders[k.toLowerCase()] = v;
  }

  let response: Response;
  const retries: string[] = [];
  const retryAttempts = Math.max(1, Math.floor(settings.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  try {
    response = await fetchWithRetry(
      baseUrl + "/v1/messages",
      {
        method: "POST",
        headers: {
          ...normalizedHeaders,
          "content-type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": API_VERSION,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      },
      {
        ...settings.retry,
        timeouts: { requestMs: timeouts.requestMs, totalMs: timeouts.totalMs },
        breakerRoute: `anthropic@${baseUrl}`,
        // 429 (rate limit) and 529 (overloaded) are routine on this API; a turn
        // must ride them out rather than die on the first one.
        onRetry: (info) => retries.push(retryNotice("anthropic", info, retryAttempts)),
      },
    );
    deadline.headersReceived();
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent("anthropic", timeout, "request");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `anthropic request failed: ${errorText(err)}`, code: "TRANSIENT" };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = maskSecrets(await response.text().catch(() => ""));
    const expired = deadline.timedOut();
    if (expired) {
      yield providerTimeoutEvent("anthropic", expired, "request");
      return;
    }
    const code = classifyProviderFailure(response.status, detail);
    yield {
      type: "error",
      message: `anthropic HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}`,
      code,
    };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "anthropic returned an empty response body", code: "EMPTY_RESPONSE" };
    return;
  }

  let stopReason: "end" | "tool_use" | "max_tokens" | "abort" = "end";
  let emittedTool = false;
  const usage: UsageShape = {};
  const meta = new Map<number, { id: string; name: string; input?: unknown }>();
  const args = new Map<number, string>();
  // ADDITIVE: signed thinking state, captured per content-block index so it can
  // be echoed on `done` and replayed by toAnthropicMessages on the next turn.
  const thinking = new Map<number, { text: string; signature: string; redacted?: string }>();
  let thinkingEcho: ThinkingEcho | undefined;
  const finalizeThinking = (index: number): void => {
    const state = thinking.get(index);
    if (!state) return;
    thinking.delete(index);
    const echo: ThinkingEcho = {};
    if (state.text) echo.text = state.text;
    if (state.signature) echo.signature = state.signature;
    if (state.redacted) echo.redacted = state.redacted;
    if (Object.keys(echo).length > 0) thinkingEcho = echo;
  };
  const thinkingState = (index: number) => {
    let state = thinking.get(index);
    if (!state) {
      state = { text: "", signature: "" };
      thinking.set(index, state);
    }
    return state;
  };

  const flush = function* (): Generator<ProviderEvent, void, unknown> {
    const indexes = [...meta.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const info = meta.get(index);
      if (!info) continue;
      // D-7 / H-5: the stream ended mid-block, so the accumulated JSON may be
      // cut off. Validate the FINAL assembled arguments exactly as a clean
      // content_block_stop does: a complete object passes through, syntax-only
      // damage is repaired, a truncated blob becomes a structured
      // tool_input_error instead of a tool_call with malformed arguments.
      const raw = anthropicToolArguments(args.get(index) ?? "", info.input);
      const validated = validateFinalToolArguments({ id: info.id, name: info.name, arguments: raw });
      if (validated.ok === false) {
        yield toolInputErrorEvent(validated.refusal);
        continue;
      }
      emittedTool = true;
      yield { type: "tool_call", id: info.id, name: info.name, arguments: validated.arguments };
    }
    meta.clear();
    args.clear();
  };

  try {
    for await (const message of readSse(response.body, { idleTimeoutMs: timeouts.idleMs })) {
      if (req.signal.aborted) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      if (message.data === "[DONE]") break;
      // H-5: strict frame parse lives in a single-purpose util, never inline in
      // the SSE loop (ruling 67 posture). An unparsable frame is not fatal: the
      // next one may be fine.
      const event = parseJsonObject(message.data);
      if (event === undefined) continue;

      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u && typeof u === "object") {
            const rawInput = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
            const cacheCreate =
              typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;
            const cacheRead =
              typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
            if (cacheCreate !== undefined) usage.cacheCreationInputTokens = cacheCreate;
            if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
            if (rawInput !== undefined) {
              if (cacheCreate !== undefined || cacheRead !== undefined) {
                // Anthropic's `input_tokens` is already non-cached; normalize
                // `inputTokens` to inclusive total (matching openai-usage.ts)
                // and preserve `nonCachedInputTokens` explicitly.
                usage.nonCachedInputTokens = rawInput;
                usage.inputTokens = rawInput + (cacheCreate ?? 0) + (cacheRead ?? 0);
              } else {
                usage.inputTokens = rawInput;
              }
            }
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          const index = typeof event.index === "number" ? event.index : 0;
          if (block && block.type === "tool_use") {
            meta.set(index, { id: String(block.id ?? ""), name: String(block.name ?? ""), input: block.input });
            args.set(index, "");
          } else if (block && block.type === "thinking") {
            thinkingState(index).text = typeof block.thinking === "string" ? block.thinking : "";
          } else if (block && block.type === "redacted_thinking") {
            thinkingState(index).redacted = typeof block.data === "string" ? block.data : undefined;
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta ?? {};
          const index = typeof event.index === "number" ? event.index : 0;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
            yield { type: "text", text: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
            // Capture the streaming text (the loop still displays it) AND keep
            // an exact copy for the signed replay block.
            thinkingState(index).text += delta.thinking;
            yield { type: "thinking", text: delta.thinking };
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string" && delta.signature !== "") {
            // A signature can arrive in several deltas; concatenate in order.
            thinkingState(index).signature += delta.signature;
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            args.set(index, (args.get(index) ?? "") + delta.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const index = typeof event.index === "number" ? event.index : 0;
          finalizeThinking(index);
          const info = meta.get(index);
          if (info) {
            meta.delete(index);
            const raw = anthropicToolArguments(args.get(index) ?? "", info.input);
            args.delete(index);
            // Track A: strict finish parse on content_block_stop. Valid JSON
            // objects emit cleanly; malformed/truncated/non-object payloads
            // attach `toolInputError` so loop.ts returns a self-correction
            // tool result without executing the tool or crashing the turn.
            const finalized = finalizeAssembledToolCall({ id: info.id, name: info.name, arguments: raw });
            emittedTool = true;
            const call: ToolCall = {
              id: finalized.id,
              name: finalized.name,
              arguments: finalized.arguments,
              ...(finalized.toolInputError !== undefined ? { toolInputError: finalized.toolInputError } : {}),
            };
            yield {
              type: "tool_call",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
              ...(call.toolInputError !== undefined ? { toolInputError: call.toolInputError } : {}),
            };
          }
          break;
        }
        case "message_delta": {
          if (typeof event.delta?.stop_reason === "string") stopReason = mapStopReason(event.delta.stop_reason);
          const output = event.usage?.output_tokens;
          if (typeof output === "number") usage.outputTokens = output;
          break;
        }
        case "message_stop":
          break;
        case "error": {
          const text = typeof event.error?.message === "string" ? event.error.message : "anthropic stream error";
          const code = classifyProviderFailure(0, text);
          yield { type: "error", message: text, code };
          return;
        }
        default:
          break;
      }
    }
  } catch (err) {
    const timeout = deadline.timedOut() ?? (isProviderTimeoutError(err) ? err : undefined);
    if (timeout) {
      yield providerTimeoutEvent("anthropic", timeout, "stream");
      return;
    }
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `anthropic stream failed: ${errorText(err)}`, code: "TRANSIENT" };
    return;
  }

  if (req.signal.aborted) {
    yield { type: "done", stopReason: "abort" };
    return;
  }

  // A tool_use (or thinking) block that never received its content_block_stop.
  for (const event of flush()) yield event;
  for (const index of [...thinking.keys()]) finalizeThinking(index);
  if (emittedTool && stopReason === "end") stopReason = "tool_use";
  const finalUsage =
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheCreationInputTokens === undefined &&
    usage.cacheReadInputTokens === undefined &&
    usage.nonCachedInputTokens === undefined
      ? undefined
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          ...(usage.nonCachedInputTokens !== undefined ? { nonCachedInputTokens: usage.nonCachedInputTokens } : {}),
        };
  yield { type: "done", stopReason, usage: finalUsage, ...(thinkingEcho ? { thinking: thinkingEcho } : {}) };
}

export function createAnthropicProvider(settings: AnthropicSettings): Provider {
  return {
    name: "anthropic",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
      withProviderDeadline(req.signal, settings.timeouts ?? {}, (deadline) => streamAnthropic(settings, req, deadline)),
  };
}

/**
 * anthropic.ts — the Claude provider.
 *
 * POST <baseUrl>/v1/messages with stream:true and translate the SSE events into
 * the provider contract: text deltas, complete tool calls, one done with the
 * stop reason. Errors become an {type:'error'} event; an abort becomes
 * done/abort. Nothing here throws at the caller.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ToolCall, ToolSpec } from "../../contracts";
import { anthropicSystemField } from "./anthropic-cache";
import { applyAnthropicRequestCacheBreakpoints } from "./anthropic-cache-wire";
import { systemPromptUpdateInHistory, wireSystemPromptInHistory } from "../system-prompt-wire";
import { DEFAULT_RETRY_ATTEMPTS, fetchWithRetry, retryNotice } from "./retry";
import { errorText, isAbortError, readSse, truncate } from "./sse";

export interface AnthropicSettings {
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function safeParse(text: unknown): unknown {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * ChatMsg[] -> Anthropic messages. Consecutive same-role messages are merged
 * because the API wants alternating turns, and tool results are user turns.
 */
export function toAnthropicMessages(messages: ChatMsg[]): AnthropicMessage[] {
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
      push("user", [{ type: "text", text: msg.content ?? "" }]);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (typeof msg.content === "string" && msg.content.trim() !== "") blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: safeParse(call.arguments) });
      }
      push("assistant", blocks);
      continue;
    }
    // tool result
    if (!msg.toolCallId) continue; // unusable without the id it answers
    push("user", [
      { type: "tool_result", tool_use_id: msg.toolCallId, content: msg.content && msg.content !== "" ? msg.content : "(no output)" },
    ]);
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

/**
 * The JSON a tool block carries. Anthropic announces the block with
 * `input:{}` and streams the object as `input_json_delta`s; a tool with no
 * arguments sends no deltas at all, and a server may put the whole object in
 * the start block. The contract says `arguments` is a JSON string, so a block
 * that streamed nothing falls back to what it declared, never to "".
 */
function toolArguments(raw: string, declared: unknown): string {
  if (raw.trim() !== "") return raw;
  if (declared !== null && typeof declared === "object" && Object.keys(declared).length > 0) {
    const encoded = JSON.stringify(declared);
    if (typeof encoded === "string" && encoded !== "") return encoded;
  }
  return "{}";
}

interface UsageShape {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

async function* streamAnthropic(settings: AnthropicSettings, req: ProviderRequest): AsyncIterable<ProviderEvent> {
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : "https://api.anthropic.com").replace(/\/+$/, "");
  const wire = systemPromptUpdateInHistory() ? wireSystemPromptInHistory(req) : req;
  let messages = toAnthropicMessages(wire.messages ?? []);
  if (messages.length === 0) {
    yield { type: "error", message: "anthropic: nothing to send (no messages after system)" };
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
  if (Array.isArray(wire.tools) && wire.tools.length > 0) body.tools = toAnthropicTools(wire.tools);

  let response: Response;
  const retries: string[] = [];
  try {
    response = await fetchWithRetry(
      baseUrl + "/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": API_VERSION,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      {
        // 429 (rate limit) and 529 (overloaded) are routine on this API; a turn
        // must ride them out rather than die on the first one.
        onRetry: (info) => retries.push(retryNotice("anthropic", info, DEFAULT_RETRY_ATTEMPTS)),
      },
    );
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `anthropic request failed: ${errorText(err)}` };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    yield { type: "error", message: `anthropic HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}` };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "anthropic returned an empty response body" };
    return;
  }

  let stopReason: "end" | "tool_use" | "max_tokens" | "abort" = "end";
  let emittedTool = false;
  const usage: UsageShape = {};
  const meta = new Map<number, { id: string; name: string; input?: unknown }>();
  const args = new Map<number, string>();

  const flush = function* (): Generator<ProviderEvent, void, unknown> {
    const indexes = [...meta.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const info = meta.get(index);
      if (!info) continue;
      emittedTool = true;
      yield { type: "tool_call", id: info.id, name: info.name, arguments: toolArguments(args.get(index) ?? "", info.input) };
    }
    meta.clear();
    args.clear();
  };

  try {
    for await (const message of readSse(response.body)) {
      if (req.signal.aborted) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      if (message.data === "[DONE]") break;
      let event: Record<string, any>;
      try {
        event = JSON.parse(message.data) as Record<string, any>;
      } catch {
        continue; // an unparsable event is not fatal: the next one may be fine
      }
      if (!event || typeof event !== "object") continue;

      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u && typeof u === "object") {
            if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
            if (typeof u.cache_creation_input_tokens === "number") {
              usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
            }
            if (typeof u.cache_read_input_tokens === "number") usage.cacheReadInputTokens = u.cache_read_input_tokens;
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          const index = typeof event.index === "number" ? event.index : 0;
          if (block && block.type === "tool_use") {
            meta.set(index, { id: String(block.id ?? ""), name: String(block.name ?? ""), input: block.input });
            args.set(index, "");
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
            yield { type: "text", text: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
            yield { type: "thinking", text: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const index = typeof event.index === "number" ? event.index : 0;
            args.set(index, (args.get(index) ?? "") + delta.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const index = typeof event.index === "number" ? event.index : 0;
          const info = meta.get(index);
          if (info) {
            meta.delete(index);
            const raw = toolArguments(args.get(index) ?? "", info.input);
            args.delete(index);
            emittedTool = true;
            const call: ToolCall = { id: info.id, name: info.name, arguments: raw };
            yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
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
          yield { type: "error", message: text };
          return;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `anthropic stream failed: ${errorText(err)}` };
    return;
  }

  if (req.signal.aborted) {
    yield { type: "done", stopReason: "abort" };
    return;
  }

  // A tool_use block that never received its content_block_stop.
  for (const event of flush()) yield event;
  if (emittedTool && stopReason === "end") stopReason = "tool_use";
  const finalUsage =
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheCreationInputTokens === undefined &&
    usage.cacheReadInputTokens === undefined
      ? undefined
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        };
  yield { type: "done", stopReason, usage: finalUsage };
}

export function createAnthropicProvider(settings: AnthropicSettings): Provider {
  return {
    name: "anthropic",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> => streamAnthropic(settings, req),
  };
}

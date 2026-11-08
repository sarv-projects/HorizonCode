/**
 * openai.ts — the OpenAI (chat completions) provider.
 *
 * POST <baseUrl>/v1/chat/completions with stream:true. Tool call deltas are
 * assembled by index, then emitted as complete tool calls before the done event
 * that carries the finish reason.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../contracts";
import { DEFAULT_RETRY_ATTEMPTS, fetchWithRetry, retryNotice } from "./retry";
import { errorText, isAbortError, readSse, truncate } from "./sse";

export interface OpenAiSettings {
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MAX_TOKENS = 4096;

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

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
      content: msg.content && msg.content !== "" ? msg.content : "(no output)",
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

async function* streamOpenAi(settings: OpenAiSettings, req: ProviderRequest): AsyncIterable<ProviderEvent> {
  const baseUrl = (settings.baseUrl && settings.baseUrl.trim() !== "" ? settings.baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, "");
  const messages = toOpenAiMessages(req.messages ?? []);
  if (messages.length === 0) {
    yield { type: "error", message: "openai: nothing to send (no messages)" };
    return;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof req.system === "string" && req.system !== "") {
    body.messages = [{ role: "system", content: req.system }, ...messages];
  }
  if (Array.isArray(req.tools) && req.tools.length > 0) body.tools = toOpenAiTools(req.tools);
  if (req.maxTokens && req.maxTokens > 0) body.max_tokens = req.maxTokens;
  else if (settings.maxTokens && settings.maxTokens > 0) body.max_tokens = settings.maxTokens;
  else body.max_tokens = DEFAULT_MAX_TOKENS;

  let response: Response;
  const retries: string[] = [];
  try {
    response = await fetchWithRetry(
      baseUrl + "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.apiKey}`,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      {
        // Ride out a rate limit or an overloaded upstream instead of failing the
        // whole turn; the notices below keep it visible rather than silent.
        onRetry: (info) => retries.push(retryNotice("openai", info, DEFAULT_RETRY_ATTEMPTS)),
      },
    );
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `openai request failed: ${errorText(err)}` };
    return;
  }
  for (const message of retries) yield { type: "notice", message };

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    yield { type: "error", message: `openai HTTP ${response.status}: ${truncate(detail.replace(/\s+/g, " ").trim(), 400)}` };
    return;
  }
  if (!response.body) {
    yield { type: "error", message: "openai returned an empty response body" };
    return;
  }

  let finish: unknown;
  let aborted = false;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  const partials = new Map<number, { id: string; name: string; args: string }>();

  try {
    for await (const message of readSse(response.body)) {
      if (req.signal.aborted) {
        aborted = true;
        break;
      }
      if (message.data === "[DONE]") break;
      let event: Record<string, any>;
      try {
        event = JSON.parse(message.data) as Record<string, any>;
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      if (event.error) {
        const text = typeof event.error.message === "string" ? event.error.message : "openai stream error";
        yield { type: "error", message: text };
        return;
      }
      if (event.usage && typeof event.usage === "object") {
        usage = {
          inputTokens: typeof event.usage.prompt_tokens === "number" ? event.usage.prompt_tokens : undefined,
          outputTokens: typeof event.usage.completion_tokens === "number" ? event.usage.completion_tokens : undefined,
        };
      }
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content !== "") {
        yield { type: "text", text: delta.content };
      }
      const deltas: OpenAiToolCallDelta[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of deltas) {
        const index = typeof call.index === "number" ? call.index : 0;
        const current = partials.get(index) ?? { id: "", name: "", args: "" };
        if (typeof call.id === "string" && call.id !== "") current.id = call.id;
        if (typeof call.function?.name === "string" && call.function.name !== "") current.name = call.function.name;
        if (typeof call.function?.arguments === "string") current.args += call.function.arguments;
        partials.set(index, current);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      yield { type: "done", stopReason: "abort" };
      return;
    }
    yield { type: "error", message: `openai stream failed: ${errorText(err)}` };
    return;
  }

  if (aborted || req.signal.aborted) {
    yield { type: "done", stopReason: "abort" };
    return;
  }

  let emitted = false;
  for (const index of [...partials.keys()].sort((a, b) => a - b)) {
    const call = partials.get(index);
    if (!call || call.name === "") continue;
    emitted = true;
    // `arguments` is a JSON string per the contract; a call that streamed no
    // fragments at all (a no-argument tool) must still be parseable, the same
    // way toOpenAiMessages already rewrites an empty replay to "{}".
    yield {
      type: "tool_call",
      id: call.id !== "" ? call.id : `call_${index + 1}`,
      name: call.name,
      arguments: call.args.trim() === "" ? "{}" : call.args,
    };
  }

  let stopReason = mapFinishReason(finish);
  if (emitted && stopReason === "end") stopReason = "tool_use";
  yield { type: "done", stopReason, usage };
}

export function createOpenAiProvider(settings: OpenAiSettings): Provider {
  return {
    name: "openai",
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> => streamOpenAi(settings, req),
  };
}

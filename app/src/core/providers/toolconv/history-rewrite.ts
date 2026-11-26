/**
 * history-rewrite.ts — fold native tool roles into text for text-only wires (docs/33 §5.5).
 *
 * The session store keeps assistant `toolCalls` and `tool` results for receipts and
 * resume; only the provider wire is rewritten. Unpaired tool rows are dropped (fail-closed).
 */

import type { ChatMsg, ToolCall } from "../../../contracts";
import type { ToolFormat } from "../../config";
import { textFromChatContent } from "../../chat-content";
import { toolResultContent } from "../tool-result-content";

function parseArgs(args: string): Record<string, unknown> {
  const t = args.trim();
  if (t === "") return {};
  try {
    const p = JSON.parse(t) as unknown;
    if (p !== null && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    /* replay as empty object */
  }
  return {};
}

function renderXmlCall(call: ToolCall): string {
  const args = JSON.stringify(parseArgs(call.arguments));
  return `<forge_tool_call>\n  <tool_name>${call.name}</tool_name>\n  <arguments>${args}</arguments>\n</forge_tool_call>`;
}

function renderHermesCall(call: ToolCall): string {
  return `<tool_call>\n${JSON.stringify({ name: call.name, arguments: parseArgs(call.arguments) })}\n</tool_call>`;
}

function renderXmlResult(name: string, content: string): string {
  const esc = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<forge_tool_response>\n  <tool_name>${name}</tool_name>\n  <result>${esc}</result>\n</forge_tool_response>`;
}

function renderHermesResult(name: string, content: string): string {
  return `<tool_response>\n${JSON.stringify({ name, content })}\n</tool_response>`;
}

import { DS_TOOL_CALLS_BEGIN, DS_TOOL_CALL_BEGIN, DS_TOOL_SEP, DS_TOOL_CALL_END, DS_TOOL_CALLS_END } from "./deepseek";
import { GEMMA_CALL_OPEN, GEMMA_CALL_CLOSE, GEMMA_STR } from "./gemma";

/** JSON args for a call, with an unparsable blob replayed as {} (never invented). */
function argsOf(call: ToolCall): Record<string, unknown> {
  return parseArgs(call.arguments);
}

function renderDeepseekCall(call: ToolCall): string {
  return `${DS_TOOL_CALLS_BEGIN}${DS_TOOL_CALL_BEGIN}${call.name}${DS_TOOL_SEP}${JSON.stringify(argsOf(call))}${DS_TOOL_CALL_END}${DS_TOOL_CALLS_END}`;
}

function renderGlmCall(call: ToolCall): string {
  const body = Object.entries(argsOf(call))
    .map(([k, v]) => `<arg_key>${k}</arg_key><arg_value>${typeof v === "string" ? v : JSON.stringify(v)}</arg_value>`)
    .join("");
  return `<tool_call>${call.name}\n${body}</tool_call>`;
}

function renderMinimaxCall(call: ToolCall): string {
  const body = Object.entries(argsOf(call))
    .map(([k, v]) => `<parameter name="${k}">${typeof v === "string" ? v : JSON.stringify(v)}</parameter>`)
    .join("");
  return `<invoke name="${call.name}">${body}</invoke>`;
}

function renderGeminiCall(call: ToolCall): string {
  const kwargs = Object.entries(argsOf(call))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return "```tool_code\n" + `${call.name}(${kwargs})` + "\n```";
}

function renderGemmaCall(call: ToolCall): string {
  const body = Object.entries(argsOf(call))
    .map(([k, v]) => `${k}:${typeof v === "string" ? `${GEMMA_STR}${v}${GEMMA_STR}` : JSON.stringify(v)}`)
    .join(",");
  return `${GEMMA_CALL_OPEN}call:${call.name}{${body}}${GEMMA_CALL_CLOSE}`;
}

function renderHarmonyCall(call: ToolCall): string {
  return `<|start|>assistant<|channel|>commentary to=functions.${call.name} <|constrain|>json<|message|>${JSON.stringify(argsOf(call))}<|call|>`;
}

function renderKimiCall(call: ToolCall, index: number): string {
  return `<|tool_call_begin|>functions.${call.name}:${index}<|tool_call_argument_begin|>${JSON.stringify(argsOf(call))}<|tool_call_end|>`;
}

/**
 * D-8: render a call in the dialect the wrapper actually parses. Before this,
 * every non-XML dialect replayed Hermes blocks, so seven wrappers replayed text
 * their own drain/parse function could not read. Each branch is the inverse of
 * that dialect parser and is round-trip tested in
 * `tests/core/toolconv-history-rewrite.test.ts`.
 */
function renderCall(call: ToolCall, dialect: ToolFormat, index: number): string {
  switch (dialect) {
    case "xml": return renderXmlCall(call);
    case "deepseek": return renderDeepseekCall(call);
    case "glm": return renderGlmCall(call);
    case "minimax":
    case "anthropic": return renderMinimaxCall(call);
    case "gemini": return renderGeminiCall(call);
    case "gemma": return renderGemmaCall(call);
    case "harmony": return renderHarmonyCall(call);
    case "kimi": return renderKimiCall(call, index);
    default: return renderHermesCall(call);
  }
}

function renderResult(name: string, content: string, dialect: ToolFormat): string {
  if (dialect === "xml") return renderXmlResult(name, content);
  if (dialect === "hermes") return renderHermesResult(name, content);
  // The in-band dialects have no result grammar; a labelled JSON response is
  // readable and is never mistaken for a call.
  return `<tool_response>\n${JSON.stringify({ name, content })}\n</tool_response>`;
}

function appendBlock(base: string, block: string): string {
  const trimmed = base.trim();
  if (trimmed === "") return block;
  return `${trimmed}\n\n${block}`;
}

/**
 * Rewrite chat history for providers without native tool messages. Assistant
 * tool-call turns and following tool results become in-band text blocks.
 */
export function rewriteHistoryForTextToolconv(messages: ChatMsg[], dialect: ToolFormat): ChatMsg[] {
  const toolResultsById = new Map<string, { name: string; content: string }>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.toolCallId || !msg.toolName) continue;
    toolResultsById.set(msg.toolCallId, {
      name: msg.toolName,
      content: toolResultContent(msg.content),
    });
  }

  const out: ChatMsg[] = [];
  const consumed = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: textFromChatContent(msg.content) });
      continue;
    }
    if (msg.role === "tool") continue;

    const calls = msg.toolCalls ?? [];
    let content = typeof msg.content === "string" ? msg.content : "";
    if (calls.length > 0) {
      for (const [index, call] of calls.entries()) {
        content = appendBlock(content, renderCall(call, dialect, index));
      }
      const responseBlocks: string[] = [];
      for (const call of calls) {
        const res = toolResultsById.get(call.id);
        if (res !== undefined) {
          responseBlocks.push(renderResult(res.name, res.content, dialect));
          consumed.add(call.id);
        }
      }
      if (content !== "" || calls.length > 0) {
        out.push({ role: "assistant", content });
      }
      if (responseBlocks.length > 0) {
        out.push({ role: "user", content: responseBlocks.join("\n\n") });
      }
      continue;
    }

    if (content !== "") out.push({ role: "assistant", content });
  }

  for (const [id, orphan] of toolResultsById) {
    if (consumed.has(id)) continue;
    out.push({
      role: "user",
      content: renderResult(orphan.name, orphan.content, dialect),
    });
  }

  return out;
}

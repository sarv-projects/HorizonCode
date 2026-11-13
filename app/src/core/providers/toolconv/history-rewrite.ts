/**
 * history-rewrite.ts — fold native tool roles into text for text-only wires (docs/33 §5.5).
 *
 * The session store keeps assistant `toolCalls` and `tool` results for receipts and
 * resume; only the provider wire is rewritten. Unpaired tool rows are dropped (fail-closed).
 */

import type { ChatMsg, ToolCall } from "../../../contracts";
import type { ToolFormat } from "../../config";

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

function renderCall(call: ToolCall, dialect: ToolFormat): string {
  return dialect === "xml" ? renderXmlCall(call) : renderHermesCall(call);
}

function renderResult(name: string, content: string, dialect: ToolFormat): string {
  return dialect === "xml" ? renderXmlResult(name, content) : renderHermesResult(name, content);
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
      content: msg.content && msg.content !== "" ? msg.content : "(no output)",
    });
  }

  const out: ChatMsg[] = [];
  const consumed = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: msg.content ?? "" });
      continue;
    }
    if (msg.role === "tool") continue;

    const calls = msg.toolCalls ?? [];
    let content = typeof msg.content === "string" ? msg.content : "";
    if (calls.length > 0) {
      for (const call of calls) {
        content = appendBlock(content, renderCall(call, dialect));
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

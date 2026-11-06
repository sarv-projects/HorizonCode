/**
 * mock.ts — the zero-config provider.
 *
 * Deterministic, instant and offline: this is what makes `hzcode` chat the moment
 * it lands on a machine, before any key exists. It answers in one short line and,
 * when the human asks what is in the workspace, performs exactly one `glob` tool
 * call so the whole pipeline (guard, receipt, tool card, event log) runs end to
 * end. It never calls a tool twice, so a turn can never loop.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest } from "../../contracts";

export const MOCK_GREETING = "Hi! I am HzCode running in mock mode. Configure a provider key to talk to a real model.";
/** Said before the single tool call, so the turn reads like a conversation. */
export const MOCK_LOOKING = "Let me look at what is in this workspace.";
export const MOCK_TOOL_CALL_ID = "mock-1";

/** The one request the mock can act on: /list files|what.*here|ls\b/i */
export const MOCK_FILE_REQUEST = /list files|what.*here|ls\b/i;

function lastMessage(messages: ChatMsg[]): ChatMsg | undefined {
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

function latestUserText(messages: ChatMsg[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user") return typeof msg.content === "string" ? msg.content : "";
  }
  return "";
}

/** One short, honest summary of whatever the tool returned. */
function summarize(toolName: string, output: string): string {
  const text = typeof output === "string" ? output.trim() : "";
  if (text === "") return `Mock mode: the ${toolName} tool returned nothing.`;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = (lines[0] ?? "").trim();
  const shown = first.length > 160 ? first.slice(0, 160) + "\u2026" : first;
  const extra = lines.length > 1 ? ` (${lines.length} lines)` : "";
  return `Mock mode: the ${toolName} tool returned ${text.length} characters${extra}. First line: ${shown}`;
}

export function createMockProvider(): Provider {
  return {
    name: "mock",

    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (req.signal.aborted) {
        yield { type: "done", stopReason: "abort" };
        return;
      }
      const messages = Array.isArray(req.messages) ? req.messages : [];
      const last = lastMessage(messages);

      // Second turn of the single tool exchange: summarize the result and stop.
      if (last && last.role === "tool") {
        yield { type: "text", text: summarize(last.toolName ?? "tool", last.content ?? "") };
        yield { type: "done", stopReason: "end" };
        return;
      }

      // A loop is impossible: a tool result always takes the branch above and ends
      // the turn, so the mock can call a tool only once per exchange.
      if (MOCK_FILE_REQUEST.test(latestUserText(messages))) {
        yield { type: "text", text: MOCK_LOOKING };
        yield { type: "tool_call", id: MOCK_TOOL_CALL_ID, name: "glob", arguments: JSON.stringify({ pattern: "*" }) };
        yield { type: "done", stopReason: "tool_use" };
        return;
      }

      yield { type: "text", text: MOCK_GREETING };
      yield { type: "done", stopReason: "end" };
    },
  };
}

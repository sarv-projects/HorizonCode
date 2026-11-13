/**
 * wrap-gemini.ts — turn assistant text into tool_call events when a tool_code fence closes.
 */

import { randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../../contracts";
import { drainCompleteGeminiToolCalls, renderGeminiToolInstructions } from "./gemini";
import { prepareInnerTextToolRequest } from "./wrap-shared";

function allowedToolNames(tools: ToolSpec[]): ReadonlySet<string> {
  return new Set(tools.map((t) => t.name));
}

function emitGeminiCalls(
  calls: { name: string; args: Record<string, unknown> }[],
): Extract<ProviderEvent, { type: "tool_call" }>[] {
  return calls.map((call) => ({
    type: "tool_call" as const,
    id: `gemini_${randomUUID()}`,
    name: call.name,
    arguments: JSON.stringify(call.args),
  }));
}

/** Wrap a text-only provider: Gemini `tool_code` fences become `tool_call` events when closed. */
export function wrapGeminiToolProvider(inner: Provider): Provider {
  return {
    name: inner.name,
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const allowed = allowedToolNames(req.tools);
      const innerReq = prepareInnerTextToolRequest(req, "gemini", renderGeminiToolInstructions);
      let buffer = "";
      let scanFrom = 0;
      let toolCallCount = 0;
      let doneEvent: Extract<ProviderEvent, { type: "done" }> | undefined;
      for await (const event of inner.stream(innerReq)) {
        if (event.type === "text") {
          buffer += event.text;
          const drained = drainCompleteGeminiToolCalls(buffer, allowed, scanFrom);
          scanFrom = drained.nextIndex;
          for (const message of drained.errors) yield { type: "notice", message };
          for (const call of emitGeminiCalls(drained.calls)) {
            toolCallCount++;
            yield call;
          }
          yield event;
        } else if (event.type === "thinking" || event.type === "notice" || event.type === "quirks") {
          yield event;
        } else if (event.type === "error") {
          yield event;
          return;
        } else if (event.type === "tool_call") {
          yield event;
        } else if (event.type === "done") {
          doneEvent = event;
        }
        if (req.signal.aborted) {
          yield { type: "done", stopReason: "abort" };
          return;
        }
      }
      const tail = drainCompleteGeminiToolCalls(buffer, allowed, scanFrom);
      for (const message of tail.errors) yield { type: "notice", message };
      for (const call of emitGeminiCalls(tail.calls)) {
        toolCallCount++;
        yield call;
      }
      const stopReason = toolCallCount > 0 ? "tool_use" : (doneEvent?.stopReason ?? "end");
      yield { type: "done", stopReason, usage: doneEvent?.usage };
    },
  };
}

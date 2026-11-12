/**
 * wrap-xml.ts — turn assistant text into tool_call events after the stream ends.
 */

import { randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, ProviderRequest, ToolSpec } from "../../../contracts";
import { parseForgeXmlToolCalls, renderForgeXmlToolInstructions } from "./xml";

function allowedToolNames(tools: ToolSpec[]): ReadonlySet<string> {
  return new Set(tools.map((t) => t.name));
}

/** Wrap a text-only provider: forge XML blocks become `tool_call` events on `done`. */
export function wrapXmlToolProvider(inner: Provider): Provider {
  return {
    name: inner.name,
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const allowed = allowedToolNames(req.tools);
      const innerReq: ProviderRequest = {
        ...req,
        system: req.system + "\n\n" + renderForgeXmlToolInstructions(req.tools),
        tools: [],
      };
      let buffer = "";
      let doneEvent: Extract<ProviderEvent, { type: "done" }> | undefined;
      for await (const event of inner.stream(innerReq)) {
        if (event.type === "text") {
          buffer += event.text;
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
      const { calls, errors } = parseForgeXmlToolCalls(buffer, allowed);
      for (const message of errors) yield { type: "notice", message };
      for (const call of calls) {
        yield {
          type: "tool_call",
          id: `xml_${randomUUID()}`,
          name: call.name,
          arguments: JSON.stringify(call.args),
        };
      }
      const stopReason = calls.length > 0 ? "tool_use" : (doneEvent?.stopReason ?? "end");
      yield { type: "done", stopReason, usage: doneEvent?.usage };
    },
  };
}

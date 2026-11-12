/**
 * toolconv/anthropic.ts — Anthropic modern XML tool dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/anthropic.md — `<function_calls>` / `<invoke>` /
 * `<parameter>` (optional `antml:` prefix). Reuses MiniMax invoke parsing.
 */

import type { ToolSpec } from "../../../contracts";
import { parseMinimaxToolCalls, type ParsedMinimaxToolCall } from "./minimax";

export type ParsedAnthropicToolCall = ParsedMinimaxToolCall;

/** Parse Anthropic/MiniMax-style invoke blocks (antml: prefix tolerated via strip). */
export function parseAnthropicToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedAnthropicToolCall[]; rest: string; errors: string[] } {
  // Strip antml: namespace and outer wrappers; invoke/parameter parsing is shared.
  const normalized = text
    .replace(/<\/?antml:/gi, (m) => m.replace(/antml:/i, ""))
    .replace(/<\/?function_calls>/gi, "")
    .replace(/<\/?tool_calls>/gi, "");
  return parseMinimaxToolCalls(normalized, allowed);
}

/** System prompt appendix for Anthropic modern XML tool calls. */
export function renderAnthropicToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const catalog = specs.map((s) =>
    JSON.stringify({
      type: "function",
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters ?? { type: "object", properties: {} },
      },
    }),
  );
  return [
    "You may call tools by emitting a complete XML block:",
    "<function_calls>",
    '<invoke name="TOOL_NAME"><parameter name="key">value</parameter></invoke>',
    "</function_calls>",
    "Do not invent tool names. Arguments are literal parameter bodies (JSON for non-strings).",
    "Available tools:",
    "<tools>",
    ...catalog,
    "</tools>",
  ].join("\n");
}

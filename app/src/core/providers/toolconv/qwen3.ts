/**
 * toolconv/qwen3.ts — Qwen3 in-band dialect (Hermes call shape; docs/33 §5.5).
 *
 * Call wire format matches Hermes (`<tool_call>` + nested JSON arguments).
 * Prompt text follows Qwen3's `# Tools` / `<tools>` template (no FunctionCall
 * pydantic schema line). History folding uses the shared Hermes-shaped blocks
 * via `rewriteHistoryForTextToolconv` (wrap-shared).
 */

import type { ToolSpec } from "../../../contracts";
import {
  drainCompleteHermesToolCalls,
  parseHermesToolCalls,
  type ParsedHermesToolCall,
} from "./hermes";

/** Qwen3 shares the Hermes `<tool_call>` wire; reuse the Hermes stream scanner. */
export const drainCompleteQwen3ToolCalls = drainCompleteHermesToolCalls;

export type ParsedQwen3ToolCall = ParsedHermesToolCall;

/** Parse complete Qwen3/Hermes `<tool_call>` blocks from assistant text. */
export function parseQwen3ToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedQwen3ToolCall[]; rest: string; errors: string[] } {
  return parseHermesToolCalls(text, allowed);
}

/** System prompt appendix matching Qwen3's `# Tools` advertisement. */
export function renderQwen3ToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const lines = specs.map((s) =>
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
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    ...lines,
    "</tools>",
    "",
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
    "`arguments` must be a nested JSON object. Do not invent tool names.",
  ].join("\n");
}

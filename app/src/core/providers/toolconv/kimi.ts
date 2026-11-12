/**
 * toolconv/kimi.ts — Kimi K2 in-band dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/kimi-k2.md — section markers with
 * `functions.{name}:{idx}` ids and JSON args after `<|tool_call_argument_begin|>`.
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedKimiToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Wire id such as `functions.read:0` when present. */
  callId?: string;
}

const CALL =
  /<\|tool_call_begin\|>\s*([^<]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gi;

function nameFromId(id: string): string {
  const trimmed = id.trim();
  const m = /^functions\.([^:]+):\d+$/.exec(trimmed);
  if (m) return m[1];
  // Tolerate bare function names if a model omits the index.
  if (trimmed.startsWith("functions.")) return trimmed.slice("functions.".length).split(":")[0] ?? "";
  return trimmed.split(":")[0] ?? "";
}

/** Parse complete Kimi tool-call blocks from assistant text. */
export function parseKimiToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedKimiToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedKimiToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(text)) !== null) {
    consumed.push(m[0]);
    const callId = m[1].trim();
    const name = nameFromId(callId);
    if (name === "" || !allowed.has(name)) {
      errors.push(`kimi tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    const rawArgs = m[2].trim();
    if (rawArgs === "") {
      calls.push({ name, args: {}, callId });
      continue;
    }
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        calls.push({ name, args: parsed as Record<string, unknown>, callId });
      } else {
        errors.push(`kimi tool ${name}: arguments must be a JSON object`);
      }
    } catch {
      errors.push(`kimi tool ${name}: arguments are not valid JSON`);
    }
  }
  for (const block of consumed) rest = rest.replace(block, "");
  rest = rest
    .replace(/<\|tool_calls_section_begin\|>/g, "")
    .replace(/<\|tool_calls_section_end\|>/g, "")
    .trim();
  return { calls, rest, errors };
}

/** System prompt appendix for Kimi K2 section-style tool calls. */
export function renderKimiToolInstructions(specs: ToolSpec[]): string {
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
    "When calling tools, emit a complete section (never partial):",
    "<|tool_calls_section_begin|>",
    "<|tool_call_begin|>functions.TOOL_NAME:0<|tool_call_argument_begin|>{\"key\":\"value\"}<|tool_call_end|>",
    "<|tool_calls_section_end|>",
    "Use `functions.{name}:{index}` ids; arguments must be a JSON object.",
    "Available tools:",
    ...catalog,
  ].join("\n");
}

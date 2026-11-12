/**
 * toolconv/minimax.ts — MiniMax `<minimax:tool_call>` / `<invoke>` dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/minimax.md — envelope with sibling invoke/parameter
 * elements; parameter bodies are delimiter-matched (not XML-escaped).
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedMinimaxToolCall {
  name: string;
  args: Record<string, unknown>;
}

const INVOKE =
  /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
const PARAM =
  /<parameter\s+name="([^"]+)"(?:\s+string="([^"]*)")?\s*>([\s\S]*?)<\/parameter>/gi;

function coerceParam(body: string, forceString: boolean | undefined): unknown {
  if (forceString === true) return body;
  const trimmed = body.trim();
  if (forceString === false || (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "true" || trimmed === "false" || trimmed === "null" || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }
  // Default: keep verbatim string (schema-aware string handling without schemas).
  return body;
}

function parseInvokeBody(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  PARAM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARAM.exec(inner)) !== null) {
    const key = m[1];
    if (!key) continue;
    const stringAttr = m[2];
    let force: boolean | undefined;
    if (stringAttr !== undefined) {
      const s = stringAttr.toLowerCase();
      force = !(s === "false" || s === "0" || s === "no");
    }
    args[key] = coerceParam(m[3], force);
  }
  return args;
}

/** Parse MiniMax invoke blocks (with or without the namespaced envelope). */
export function parseMinimaxToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedMinimaxToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedMinimaxToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  INVOKE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE.exec(text)) !== null) {
    consumed.push(m[0]);
    const name = m[1].trim();
    if (name === "" || !allowed.has(name)) {
      errors.push(`minimax tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    calls.push({ name, args: parseInvokeBody(m[2]) });
  }
  for (const block of consumed) rest = rest.replace(block, "");
  rest = rest
    .replace(/<\/?minimax:tool_call>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim();
  return { calls, rest, errors };
}

/** System prompt appendix for the MiniMax invoke envelope. */
export function renderMinimaxToolInstructions(specs: ToolSpec[]): string {
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
    "# Tools",
    "Call tools as text using this envelope (complete tags only):",
    "<minimax:tool_call>",
    '<invoke name="TOOL_NAME"><parameter name="key">value</parameter></invoke>',
    "</minimax:tool_call>",
    "Do not invent tool names. Do not emit <function_results> yourself.",
    "Available tools:",
    "<tools>",
    ...catalog,
    "</tools>",
  ].join("\n");
}

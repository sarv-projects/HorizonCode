/**
 * toolconv/glm.ts — GLM-4.5 / 4.6 in-band dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/glm-4.5.md — `<tool_call>{name}` then
 * alternating `<arg_key>` / `<arg_value>` pairs (values: bare strings or JSON
 * literals for number/boolean/null/object/array).
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedGlmToolCall {
  name: string;
  args: Record<string, unknown>;
}

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const PAIR = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;

function parseArgValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  // Bare string (no surrounding quotes on the wire).
  return v;
}

/** Parse complete GLM `<tool_call>` blocks from assistant text. */
export function parseGlmToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedGlmToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedGlmToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK.exec(text)) !== null) {
    consumed.push(m[0]);
    const inner = m[1];
    const nl = inner.indexOf("\n");
    const nameLine = (nl === -1 ? inner : inner.slice(0, nl)).trim();
    const body = nl === -1 ? "" : inner.slice(nl + 1);
    const name = nameLine;
    if (name === "" || !allowed.has(name)) {
      errors.push(`glm tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    const args: Record<string, unknown> = {};
    PAIR.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PAIR.exec(body)) !== null) {
      const key = p[1].trim();
      if (key === "") continue;
      args[key] = parseArgValue(p[2]);
    }
    calls.push({ name, args });
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
}

/** System prompt appendix for GLM arg_key/arg_value tool calls. */
export function renderGlmToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const names = specs.map((s) => s.name).join(", ");
  return [
    "When calling a tool, emit a complete block (never partial):",
    "<tool_call>TOOL_NAME",
    "<arg_key>key</arg_key>",
    "<arg_value>value</arg_value>",
    "</tool_call>",
    "Put the tool name on the same line as `<tool_call>` with no space after the tag.",
    "String values are bare text; numbers, booleans, null, objects, and arrays use JSON literals.",
    `Allowed tool names: ${names}.`,
  ].join("\n");
}

/**
 * toolconv/hermes.ts — Hermes 2 Pro / ChatML `<tool_call>` dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/hermes.md — nested JSON `arguments` object inside
 * `<tool_call>…</tool_call>`; no per-call id on the wire.
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedHermesToolCall {
  name: string;
  args: Record<string, unknown>;
}

const OPEN_TAG = /<tool_call>/i;
const CLOSE_TAG = /<\/tool_call>/i;
const BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

function parseHermesInner(
  inner: string,
  allowed: ReadonlySet<string>,
): { call?: ParsedHermesToolCall; error?: string } {
  const trimmed = inner.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "hermes tool block: body is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "hermes tool block: body must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name === "" || !allowed.has(name)) {
    return { error: `hermes tool block: unknown or missing tool ${JSON.stringify(name)}` };
  }
  let args: Record<string, unknown> = {};
  const rawArgs = obj.arguments;
  if (rawArgs === undefined || rawArgs === null) {
    args = {};
  } else if (typeof rawArgs === "string") {
    try {
      const reparsed = JSON.parse(rawArgs);
      if (reparsed !== null && typeof reparsed === "object" && !Array.isArray(reparsed)) {
        args = reparsed as Record<string, unknown>;
      } else {
        return { error: `hermes tool ${name}: arguments must be a JSON object` };
      }
    } catch {
      return { error: `hermes tool ${name}: arguments string is not valid JSON` };
    }
  } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  } else {
    return { error: `hermes tool ${name}: arguments must be a JSON object` };
  }
  return { call: { name, args } };
}

/**
 * Scan `buffer` from `fromIndex` for closed Hermes `<tool_call>` blocks only.
 * Stops at the first incomplete open tag (fail-closed for partial streams).
 */
export function drainCompleteHermesToolCalls(
  buffer: string,
  allowed: ReadonlySet<string>,
  fromIndex: number,
): { calls: ParsedHermesToolCall[]; errors: string[]; nextIndex: number } {
  const calls: ParsedHermesToolCall[] = [];
  const errors: string[] = [];
  let i = fromIndex;
  while (i < buffer.length) {
    const tail = buffer.slice(i);
    const openMatch = OPEN_TAG.exec(tail);
    if (!openMatch) break;
    const afterOpen = i + openMatch.index + openMatch[0].length;
    const closeTail = buffer.slice(afterOpen);
    const closeMatch = CLOSE_TAG.exec(closeTail);
    if (!closeMatch) break;
    const inner = closeTail.slice(0, closeMatch.index);
    const closeEnd = afterOpen + closeMatch.index + closeMatch[0].length;
    const parsed = parseHermesInner(inner, allowed);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.call) calls.push(parsed.call);
    i = closeEnd;
  }
  return { calls, errors, nextIndex: i };
}

/** Parse complete Hermes `<tool_call>` blocks from assistant text. */
export function parseHermesToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedHermesToolCall[]; rest: string; errors: string[] } {
  const { calls, errors, nextIndex } = drainCompleteHermesToolCalls(text, allowed, 0);
  let rest = text;
  let m: RegExpExecArray | null;
  const consumed: string[] = [];
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(text.slice(0, nextIndex))) !== null) {
    consumed.push(m[0]);
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
}

/** System prompt appendix for Hermes in-band tool calling. */
export function renderHermesToolInstructions(specs: ToolSpec[]): string {
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
    "You may call one or more tools. Emit each call as a complete block (never partial):",
    "<tool_call>",
    '{"name": "TOOL_NAME", "arguments": {"key": "value"}}',
    "</tool_call>",
    "`arguments` must be a nested JSON object (not a string). Do not invent tool names.",
    "Available tools:",
    "<tools>",
    catalog.join("\n"),
    "</tools>",
  ].join("\n");
}

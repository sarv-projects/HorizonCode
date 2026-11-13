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

const KIMI_CALL_OPEN = /<\|(?:redacted_)?tool_call_begin(?:_kimi)?\|>/i;
const KIMI_ARG_BEGIN = /<\|(?:redacted_)?tool_call_argument_begin\|>/i;
const KIMI_CALL_CLOSE = /<\|(?:redacted_)?tool_call_end(?:_kimi)?\|>/i;
const CALL =
  /<\|(?:redacted_)?tool_call_begin(?:_kimi)?\|>\s*([^<]+?)\s*<\|(?:redacted_)?tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|(?:redacted_)?tool_call_end(?:_kimi)?\|>/gi;

function nameFromId(id: string): string {
  const trimmed = id.trim();
  const m = /^functions\.([^:]+):\d+$/.exec(trimmed);
  if (m) return m[1];
  // Tolerate bare function names if a model omits the index.
  if (trimmed.startsWith("functions.")) return trimmed.slice("functions.".length).split(":")[0] ?? "";
  return trimmed.split(":")[0] ?? "";
}

function parseKimiPayload(
  callId: string,
  rawArgs: string,
  allowed: ReadonlySet<string>,
): { call?: ParsedKimiToolCall; error?: string } {
  const name = nameFromId(callId);
  if (name === "" || !allowed.has(name)) {
    return { error: `kimi tool block: unknown or missing tool ${JSON.stringify(name)}` };
  }
  const trimmed = rawArgs.trim();
  if (trimmed === "") return { call: { name, args: {}, callId } };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { call: { name, args: parsed as Record<string, unknown>, callId } };
    }
    return { error: `kimi tool ${name}: arguments must be a JSON object` };
  } catch {
    return { error: `kimi tool ${name}: arguments are not valid JSON` };
  }
}

/**
 * Scan `buffer` from `fromIndex` for closed Kimi tool-call sections only.
 * Stops at the first incomplete marker (fail-closed for partial streams).
 */
export function drainCompleteKimiToolCalls(
  buffer: string,
  allowed: ReadonlySet<string>,
  fromIndex: number,
): { calls: ParsedKimiToolCall[]; errors: string[]; nextIndex: number } {
  const calls: ParsedKimiToolCall[] = [];
  const errors: string[] = [];
  let i = fromIndex;
  while (i < buffer.length) {
    const tail = buffer.slice(i);
    const openMatch = KIMI_CALL_OPEN.exec(tail);
    if (!openMatch) break;
    const afterOpen = i + openMatch.index + openMatch[0].length;
    const mid = buffer.slice(afterOpen);
    const argMatch = KIMI_ARG_BEGIN.exec(mid);
    if (!argMatch) break;
    const callId = mid.slice(0, argMatch.index).trim();
    const afterArg = afterOpen + argMatch.index + argMatch[0].length;
    const closeTail = buffer.slice(afterArg);
    const closeMatch = KIMI_CALL_CLOSE.exec(closeTail);
    if (!closeMatch) break;
    const rawArgs = closeTail.slice(0, closeMatch.index);
    const closeEnd = afterArg + closeMatch.index + closeMatch[0].length;
    const parsed = parseKimiPayload(callId, rawArgs, allowed);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.call) calls.push(parsed.call);
    i = closeEnd;
  }
  return { calls, errors, nextIndex: i };
}

/** Parse complete Kimi tool-call blocks from assistant text. */
export function parseKimiToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedKimiToolCall[]; rest: string; errors: string[] } {
  const { calls, errors, nextIndex } = drainCompleteKimiToolCalls(text, allowed, 0);
  let rest = text;
  const consumed: string[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(text.slice(0, nextIndex))) !== null) {
    consumed.push(m[0]);
  }
  for (const block of consumed) rest = rest.replace(block, "");
  rest = rest
    .replace(/<\|(?:redacted_)?tool_calls_section_begin\|>/g, "")
    .replace(/<\|(?:redacted_)?tool_calls_section_end\|>/g, "")
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

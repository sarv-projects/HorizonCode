/**
 * toolconv/xml.ts — forge XML tool dialect (docs/33 §5.14 starter).
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedXmlToolCall {
  name: string;
  args: Record<string, unknown>;
}

const OPEN_TAG = /<forge_tool_call>/i;
const CLOSE_TAG = /<\/forge_tool_call>/i;

function parseForgeXmlInner(inner: string, allowed: ReadonlySet<string>): { call?: ParsedXmlToolCall; error?: string } {
  const trimmed = inner.trim();
  const nameMatch = /<tool_name>\s*([^<]+?)\s*<\/tool_name>/i.exec(trimmed);
  const argsMatch = /<arguments>\s*([\s\S]*?)\s*<\/arguments>/i.exec(trimmed);
  const name = nameMatch?.[1]?.trim() ?? "";
  if (name === "" || !allowed.has(name)) {
    return { error: `xml tool block: unknown or missing tool ${JSON.stringify(name)}` };
  }
  let args: Record<string, unknown> = {};
  if (argsMatch) {
    try {
      const parsed = JSON.parse(argsMatch[1]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      else return { error: `xml tool ${name}: arguments must be a JSON object` };
    } catch {
      return { error: `xml tool ${name}: arguments are not valid JSON` };
    }
  }
  return { call: { name, args } };
}

/**
 * Scan `buffer` from `fromIndex` for closed `forge_tool_call` blocks only.
 * Stops at the first incomplete open tag (fail-closed for partial streams).
 */
export function drainCompleteForgeXmlToolCalls(
  buffer: string,
  allowed: ReadonlySet<string>,
  fromIndex: number,
): { calls: ParsedXmlToolCall[]; errors: string[]; nextIndex: number } {
  const calls: ParsedXmlToolCall[] = [];
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
    const parsed = parseForgeXmlInner(inner, allowed);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.call) calls.push(parsed.call);
    i = closeEnd;
  }
  return { calls, errors, nextIndex: i };
}

/** Parse complete forge_tool_call blocks from assistant text. */
export function parseForgeXmlToolCalls(text: string, allowed: ReadonlySet<string>): { calls: ParsedXmlToolCall[]; rest: string; errors: string[] } {
  const { calls, errors, nextIndex } = drainCompleteForgeXmlToolCalls(text, allowed, 0);
  let rest = text;
  for (const block of completeBlocksIn(text.slice(0, nextIndex))) {
    rest = rest.replace(block, "");
  }
  return { calls, rest: rest.trim(), errors };
}

function completeBlocksIn(text: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const tail = text.slice(i);
    const openMatch = OPEN_TAG.exec(tail);
    if (!openMatch) break;
    const afterOpen = i + openMatch.index + openMatch[0].length;
    const closeTail = text.slice(afterOpen);
    const closeMatch = CLOSE_TAG.exec(closeTail);
    if (!closeMatch) break;
    const start = i + openMatch.index;
    const end = afterOpen + closeMatch.index + closeMatch[0].length;
    blocks.push(text.slice(start, end));
    i = end;
  }
  return blocks;
}

/** System prompt appendix for models without native tool calling. */
export function renderForgeXmlToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const names = specs.map((s) => s.name).join(", ");
  return [
    "When you need to call a tool, emit exactly one XML block per call (no partial blocks):",
    "<forge_tool_call>",
    "  <tool_name>TOOL_NAME</tool_name>",
    "  <arguments>{\"key\":\"value\"}</arguments>",
    "</forge_tool_call>",
    `Allowed tool names: ${names}. Arguments must be a single JSON object.`,
  ].join("\n");
}

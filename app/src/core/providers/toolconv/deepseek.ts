/**
 * toolconv/deepseek.ts — DeepSeek-V3.1 in-band dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/deepseek.md — fullwidth-pipe markers
 * (`｜` U+FF5C) and SentencePiece `▁` (U+2581) separators. Do not ASCII-fold.
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedDeepseekToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Verbatim DeepSeek control tokens (fullwidth pipe + ▁). */
const FW = "\uFF5C";
const SP = "\u2581";
export const DS_TOOL_CALL_BEGIN = `<${FW}tool${SP}call${SP}begin${FW}>`;
export const DS_TOOL_CALL_END = `<${FW}tool${SP}call${SP}end${FW}>`;
export const DS_TOOL_SEP = `<${FW}tool${SP}sep${FW}>`;
export const DS_TOOL_CALLS_BEGIN = `<${FW}tool${SP}calls${SP}begin${FW}>`;
export const DS_TOOL_CALLS_END = `<${FW}tool${SP}calls${SP}end${FW}>`;

const CALL = new RegExp(
  `${escapeRegExp(DS_TOOL_CALL_BEGIN)}([\\s\\S]*?)${escapeRegExp(DS_TOOL_SEP)}([\\s\\S]*?)${escapeRegExp(DS_TOOL_CALL_END)}`,
  "g",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDeepseekCallPayload(
  name: string,
  rawArgs: string,
  allowed: ReadonlySet<string>,
): { call?: ParsedDeepseekToolCall; error?: string } {
  if (name === "" || !allowed.has(name)) {
    return { error: `deepseek tool block: unknown or missing tool ${JSON.stringify(name)}` };
  }
  const trimmed = rawArgs.trim();
  if (trimmed === "") return { call: { name, args: {} } };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { call: { name, args: parsed as Record<string, unknown> } };
    }
    return { error: `deepseek tool ${name}: arguments must be a JSON object` };
  } catch {
    return { error: `deepseek tool ${name}: arguments are not valid JSON` };
  }
}

/**
 * Scan `buffer` from `fromIndex` for closed DeepSeek tool-call blocks only.
 * Stops at the first incomplete marker sequence (fail-closed for partial streams).
 */
export function drainCompleteDeepseekToolCalls(
  buffer: string,
  allowed: ReadonlySet<string>,
  fromIndex: number,
): { calls: ParsedDeepseekToolCall[]; errors: string[]; nextIndex: number } {
  const calls: ParsedDeepseekToolCall[] = [];
  const errors: string[] = [];
  let i = fromIndex;
  while (i < buffer.length) {
    const tail = buffer.slice(i);
    const openRel = tail.indexOf(DS_TOOL_CALL_BEGIN);
    if (openRel < 0) break;
    const afterBegin = i + openRel + DS_TOOL_CALL_BEGIN.length;
    const sepRel = buffer.indexOf(DS_TOOL_SEP, afterBegin);
    if (sepRel < 0) break;
    const afterSep = sepRel + DS_TOOL_SEP.length;
    const endRel = buffer.indexOf(DS_TOOL_CALL_END, afterSep);
    if (endRel < 0) break;
    const closeEnd = endRel + DS_TOOL_CALL_END.length;
    const name = buffer.slice(afterBegin, sepRel).trim();
    const rawArgs = buffer.slice(afterSep, endRel);
    const parsed = parseDeepseekCallPayload(name, rawArgs, allowed);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.call) calls.push(parsed.call);
    i = closeEnd;
  }
  return { calls, errors, nextIndex: i };
}

/** Parse complete DeepSeek V3.1 tool-call blocks from assistant text. */
export function parseDeepseekToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedDeepseekToolCall[]; rest: string; errors: string[] } {
  const { calls, errors, nextIndex } = drainCompleteDeepseekToolCalls(text, allowed, 0);
  let rest = text;
  const consumed: string[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(text.slice(0, nextIndex))) !== null) {
    consumed.push(m[0]);
  }
  for (const block of consumed) rest = rest.replace(block, "");
  rest = rest.replaceAll(DS_TOOL_CALLS_BEGIN, "").replaceAll(DS_TOOL_CALLS_END, "").trim();
  return { calls, rest, errors };
}

/** System prompt appendix matching DeepSeek's `## Tools` advertisement. */
export function renderDeepseekToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const sections: string[] = [
    "## Tools",
    "You have access to the following tools:",
    "",
  ];
  for (const s of specs) {
    sections.push(`### ${s.name}`);
    sections.push(`Description: ${s.description}`);
    sections.push("");
    sections.push(`Parameters: ${JSON.stringify(s.parameters ?? { type: "object", properties: {} })}`);
    sections.push("");
  }
  sections.push("IMPORTANT: Emit each call inside the DeepSeek markers, for example:");
  sections.push(
    `${DS_TOOL_CALLS_BEGIN}${DS_TOOL_CALL_BEGIN}TOOL_NAME${DS_TOOL_SEP}{"key":"value"}${DS_TOOL_CALL_END}${DS_TOOL_CALLS_END}`,
  );
  sections.push("Arguments must be a JSON object. Do not invent tool names.");
  return sections.join("\n");
}

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

/** Parse complete DeepSeek V3.1 tool-call blocks from assistant text. */
export function parseDeepseekToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedDeepseekToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedDeepseekToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(text)) !== null) {
    consumed.push(m[0]);
    const name = m[1].trim();
    if (name === "" || !allowed.has(name)) {
      errors.push(`deepseek tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    const rawArgs = m[2].trim();
    if (rawArgs === "") {
      calls.push({ name, args: {} });
      continue;
    }
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        calls.push({ name, args: parsed as Record<string, unknown> });
      } else {
        errors.push(`deepseek tool ${name}: arguments must be a JSON object`);
      }
    } catch {
      errors.push(`deepseek tool ${name}: arguments are not valid JSON`);
    }
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

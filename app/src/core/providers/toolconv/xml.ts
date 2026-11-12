/**
 * toolconv/xml.ts — forge XML tool dialect (docs/33 §5.14 starter).
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedXmlToolCall {
  name: string;
  args: Record<string, unknown>;
}

const BLOCK = /<forge_tool_call>([\s\S]*?)<\/forge_tool_call>/gi;

/** Parse complete forge_tool_call blocks from assistant text. */
export function parseForgeXmlToolCalls(text: string, allowed: ReadonlySet<string>): { calls: ParsedXmlToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedXmlToolCall[] = [];
  let rest = text;
  let m: RegExpExecArray | null;
  const consumed: string[] = [];
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(text)) !== null) {
    consumed.push(m[0]);
    const inner = m[1].trim();
    const nameMatch = /<tool_name>\s*([^<]+?)\s*<\/tool_name>/i.exec(inner);
    const argsMatch = /<arguments>\s*([\s\S]*?)\s*<\/arguments>/i.exec(inner);
    const name = nameMatch?.[1]?.trim() ?? "";
    if (name === "" || !allowed.has(name)) {
      errors.push(`xml tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    let args: Record<string, unknown> = {};
    if (argsMatch) {
      try {
        const parsed = JSON.parse(argsMatch[1]);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else {
          errors.push(`xml tool ${name}: arguments must be a JSON object`);
          continue;
        }
      } catch {
        errors.push(`xml tool ${name}: arguments are not valid JSON`);
        continue;
      }
    }
    calls.push({ name, args });
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
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

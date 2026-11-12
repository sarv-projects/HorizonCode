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

const BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/** Parse complete Hermes `<tool_call>` blocks from assistant text. */
export function parseHermesToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedHermesToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedHermesToolCall[] = [];
  let rest = text;
  let m: RegExpExecArray | null;
  const consumed: string[] = [];
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(text)) !== null) {
    consumed.push(m[0]);
    const inner = m[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      errors.push("hermes tool block: body is not valid JSON");
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push("hermes tool block: body must be a JSON object");
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (name === "" || !allowed.has(name)) {
      errors.push(`hermes tool block: unknown or missing tool ${JSON.stringify(name)}`);
      continue;
    }
    let args: Record<string, unknown> = {};
    const rawArgs = obj.arguments;
    if (rawArgs === undefined || rawArgs === null) {
      args = {};
    } else if (typeof rawArgs === "string") {
      // OpenAI boundary sometimes stringifies; tolerate for robustness (omp does).
      try {
        const reparsed = JSON.parse(rawArgs);
        if (reparsed !== null && typeof reparsed === "object" && !Array.isArray(reparsed)) {
          args = reparsed as Record<string, unknown>;
        } else {
          errors.push(`hermes tool ${name}: arguments must be a JSON object`);
          continue;
        }
      } catch {
        errors.push(`hermes tool ${name}: arguments string is not valid JSON`);
        continue;
      }
    } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      errors.push(`hermes tool ${name}: arguments must be a JSON object`);
      continue;
    }
    calls.push({ name, args });
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

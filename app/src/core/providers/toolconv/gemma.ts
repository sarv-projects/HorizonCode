/**
 * toolconv/gemma.ts — Gemma 4 token-delimited dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/gemma.md —
 * `<|tool_call>call:NAME{key:<|"|>value<|"|>}<tool_call|>`
 * (asymmetric pipes; string delimiter token `<|"|>`).
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedGemmaToolCall {
  name: string;
  args: Record<string, unknown>;
}

export const GEMMA_CALL_OPEN = "<|tool_call>";
export const GEMMA_CALL_CLOSE = "<tool_call|>";
export const GEMMA_STR = '<|"|>';

/** Find the next close marker, skipping `<|"|>…<|"|>` string spans. */
function findClose(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text.startsWith(GEMMA_STR, i)) {
      const end = text.indexOf(GEMMA_STR, i + GEMMA_STR.length);
      if (end < 0) return -1;
      i = end + GEMMA_STR.length;
      continue;
    }
    if (text.startsWith(GEMMA_CALL_CLOSE, i)) return i;
    i++;
  }
  return -1;
}

function decodeScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  if (v === "null" || v === "none" || v === "None") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Decode a Gemma brace value (string token, scalar, list, or nested object). */
export function decodeGemmaValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith(GEMMA_STR) && v.endsWith(GEMMA_STR) && v.length >= GEMMA_STR.length * 2) {
    return v.slice(GEMMA_STR.length, v.length - GEMMA_STR.length);
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitTopLevel(v.slice(1, -1)).map(decodeGemmaValue);
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    return parseBraceObject(v.slice(1, -1));
  }
  return decodeScalar(v);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    if (body.startsWith(GEMMA_STR, i)) {
      const end = body.indexOf(GEMMA_STR, i + GEMMA_STR.length);
      if (end < 0) {
        cur += body.slice(i);
        break;
      }
      cur += body.slice(i, end + GEMMA_STR.length);
      i = end + GEMMA_STR.length;
      continue;
    }
    const ch = body[i];
    if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseBraceObject(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of splitTopLevel(body)) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim();
    if (!/^[A-Za-z_]\w*$/.test(key)) continue;
    out[key] = decodeGemmaValue(part.slice(colon + 1));
  }
  return out;
}

/** Parse complete Gemma 4 `<|tool_call>…<tool_call|>` blocks. */
export function parseGemmaToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedGemmaToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedGemmaToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const open = text.indexOf(GEMMA_CALL_OPEN, searchFrom);
    if (open < 0) break;
    const bodyStart = open + GEMMA_CALL_OPEN.length;
    const close = findClose(text, bodyStart);
    if (close < 0) break;
    const block = text.slice(open, close + GEMMA_CALL_CLOSE.length);
    consumed.push(block);
    searchFrom = close + GEMMA_CALL_CLOSE.length;
    const inner = text.slice(bodyStart, close).trim();
    const head = /^call:([A-Za-z_]\w*)\{([\s\S]*)\}$/.exec(inner);
    if (!head) {
      // Tolerate missing final brace: call:NAME{body
      const loose = /^call:([A-Za-z_]\w*)\{([\s\S]*)$/.exec(inner);
      if (!loose) {
        errors.push("gemma tool block: malformed call head");
        continue;
      }
      const name = loose[1];
      if (!allowed.has(name)) {
        errors.push(`gemma tool block: unknown tool ${JSON.stringify(name)}`);
        continue;
      }
      calls.push({ name, args: parseBraceObject(loose[2]) });
      continue;
    }
    const name = head[1];
    if (!allowed.has(name)) {
      errors.push(`gemma tool block: unknown tool ${JSON.stringify(name)}`);
      continue;
    }
    calls.push({ name, args: parseBraceObject(head[2]) });
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
}

/** System prompt appendix for Gemma 4 token-delimited tool calls. */
export function renderGemmaToolInstructions(specs: ToolSpec[]): string {
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
    "Emit each tool call as a complete token-delimited block:",
    `${GEMMA_CALL_OPEN}call:TOOL_NAME{key:${GEMMA_STR}value${GEMMA_STR}}${GEMMA_CALL_CLOSE}`,
    "Strings use the <|\"|> delimiter token; booleans/numbers/null are bare.",
    "Available tools:",
    "<tools>",
    ...catalog,
    "</tools>",
  ].join("\n");
}

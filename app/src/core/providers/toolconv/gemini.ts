/**
 * toolconv/gemini.ts — Gemini/Gemma Pythonic `tool_code` dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/gemini.md — fenced ```tool_code blocks with
 * `default_api.NAME(kwargs)` / `print(...)` / bare `NAME(...)` forms.
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedGeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

const FENCE = /```tool_code\s*\n([\s\S]*?)```/gi;

/** Decode a Python-ish literal used in kwargs (not a full interpreter). */
export function decodePythonLiteral(raw: string): unknown {
  const v = raw.trim();
  if (v === "True" || v === "true") return true;
  if (v === "False" || v === "false") return false;
  if (v === "None" || v === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    const q = v[0];
    let out = "";
    for (let i = 1; i < v.length - 1; i++) {
      if (v[i] === "\\" && i + 1 < v.length - 1) {
        const n = v[i + 1];
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "\\" || n === "'" || n === '"') out += n;
        else out += n;
        i++;
      } else if (v[i] === q) break;
      else out += v[i];
    }
    return out;
  }
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
    try {
      // Accept JSON-shaped literals; Python True/False/None already handled above for scalars.
      return JSON.parse(v.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"));
    } catch {
      return v;
    }
  }
  return v;
}

/** Split top-level comma-separated kwargs, respecting quotes and nesting. */
function splitTopLevel(argsBody: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < argsBody.length; i++) {
    const ch = argsBody[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < argsBody.length) {
        cur += argsBody[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseKwargs(argsBody: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(argsBody)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    args[key] = decodePythonLiteral(part.slice(eq + 1));
  }
  return args;
}

/**
 * Extract call expressions from a tool_code body. Skips string contents when
 * finding callees; strips print()/default_api./assignment wrappers.
 */
export function extractGeminiCallsFromBody(
  body: string,
  allowed: ReadonlySet<string>,
  errors: string[],
): ParsedGeminiToolCall[] {
  const calls: ParsedGeminiToolCall[] = [];
  // Match optional wrappers then NAME( ... )
  const CALL =
    /(?:print\s*\(\s*)?(?:(?:[A-Za-z_][\w.]*)\s*=\s*)?(?:default_api\.)?([A-Za-z_][\w]*)\s*\(/g;
  let m: RegExpExecArray | null;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(body)) !== null) {
    const name = m[1];
    // Find matching close paren with string awareness.
    let i = CALL.lastIndex;
    let depth = 1;
    let quote: '"' | "'" | null = null;
    const start = i;
    while (i < body.length && depth > 0) {
      const ch = body[i];
      if (quote) {
        if (ch === "\\" && i + 1 < body.length) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (depth !== 0) {
      errors.push(`gemini tool ${name}: unterminated argument list`);
      continue;
    }
    const argsBody = body.slice(start, i - 1);
    CALL.lastIndex = i;
    if (!allowed.has(name)) {
      // Skip wrappers that are not tools (e.g. accidental matches); only error unknown names that look like calls.
      if (name !== "print") errors.push(`gemini tool block: unknown tool ${JSON.stringify(name)}`);
      continue;
    }
    calls.push({ name, args: parseKwargs(argsBody) });
  }
  return calls;
}

/** Parse complete ```tool_code fences from assistant text. */
export function parseGeminiToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedGeminiToolCall[]; rest: string; errors: string[] } {
  const errors: string[] = [];
  const calls: ParsedGeminiToolCall[] = [];
  let rest = text;
  const consumed: string[] = [];
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text)) !== null) {
    consumed.push(m[0]);
    calls.push(...extractGeminiCallsFromBody(m[1], allowed, errors));
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
}

/** System prompt appendix for the Pythonic Gemini/Gemma tool convention. */
export function renderGeminiToolInstructions(specs: ToolSpec[]): string {
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
    "You have access to functions. If you decide to invoke any, put them in a fenced tool_code block:",
    "```tool_code",
    'print(default_api.TOOL_NAME(key="value"))',
    "```",
    "Use keyword arguments with Python literals (True/False/None, quoted strings).",
    "Available tools:",
    "<tools>",
    ...catalog,
    "</tools>",
  ].join("\n");
}

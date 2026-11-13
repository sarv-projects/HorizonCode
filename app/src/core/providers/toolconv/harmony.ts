/**
 * toolconv/harmony.ts — OpenAI Harmony in-band dialect (docs/33 §5.5).
 *
 * Spec: oh-my-pi docs/toolconv/harmony.md — assistant commentary channel with
 * `to=functions.NAME` and JSON body terminated by `<|call|>`.
 */

import type { ToolSpec } from "../../../contracts";

export interface ParsedHarmonyToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Match a complete Harmony tool-call message. Recipient may sit in the role or
 * channel section; we accept either and strip a leading `functions.` prefix.
 */
const CALL =
  /<\|start\|>assistant(?:\s+to=([^\s|<]+))?<\|channel\|>commentary(?:\s+to=([^\s|<]+))?(?:\s*<\|constrain\|>\w+)?\s*<\|message\|>([\s\S]*?)<\|call\|>/gi;

/** Alternate form that opens on `<|channel|>` alone (role omitted → assistant). */
const CALL_CHANNEL_FIRST =
  /<\|channel\|>commentary(?:\s+to=([^\s|<]+))?(?:\s*<\|constrain\|>\w+)?\s*<\|message\|>([\s\S]*?)<\|call\|>/gi;

function normalizeName(raw: string | undefined): string {
  if (!raw) return "";
  const t = raw.trim();
  return t.startsWith("functions.") ? t.slice("functions.".length) : t;
}

function parseBody(
  name: string,
  body: string,
  allowed: ReadonlySet<string>,
  errors: string[],
  calls: ParsedHarmonyToolCall[],
): void {
  if (name === "" || !allowed.has(name)) {
    errors.push(`harmony tool block: unknown or missing tool ${JSON.stringify(name)}`);
    return;
  }
  const trimmed = body.trim();
  if (trimmed === "") {
    calls.push({ name, args: {} });
    return;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      calls.push({ name, args: parsed as Record<string, unknown> });
    } else {
      errors.push(`harmony tool ${name}: arguments must be a JSON object`);
    }
  } catch {
    errors.push(`harmony tool ${name}: arguments are not valid JSON`);
  }
}

const HARMONY_CALL_CLOSE = "<|call|>";

function findHarmonyOpen(tail: string): number {
  const a = tail.indexOf("<|start|>assistant");
  const b = tail.indexOf("<|channel|>commentary");
  if (a < 0 && b < 0) return -1;
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseHarmonyBlock(
  block: string,
  allowed: ReadonlySet<string>,
  errors: string[],
  calls: ParsedHarmonyToolCall[],
): void {
  CALL.lastIndex = 0;
  let m = CALL.exec(block);
  if (m) {
    const name = normalizeName(m[1] || m[2]);
    parseBody(name, m[3] ?? "", allowed, errors, calls);
    return;
  }
  CALL_CHANNEL_FIRST.lastIndex = 0;
  m = CALL_CHANNEL_FIRST.exec(block);
  if (m) {
    const name = normalizeName(m[1]);
    parseBody(name, m[2] ?? "", allowed, errors, calls);
    return;
  }
  errors.push("harmony tool block: malformed message");
}

/**
 * Scan `buffer` from `fromIndex` for closed Harmony messages (`<|call|>`) only.
 * Stops at the first incomplete opener (fail-closed for partial streams).
 */
export function drainCompleteHarmonyToolCalls(
  buffer: string,
  allowed: ReadonlySet<string>,
  fromIndex: number,
): { calls: ParsedHarmonyToolCall[]; errors: string[]; nextIndex: number } {
  const calls: ParsedHarmonyToolCall[] = [];
  const errors: string[] = [];
  let i = fromIndex;
  while (i < buffer.length) {
    const tail = buffer.slice(i);
    const relOpen = findHarmonyOpen(tail);
    if (relOpen < 0) break;
    const start = i + relOpen;
    const closeIdx = buffer.indexOf(HARMONY_CALL_CLOSE, start);
    if (closeIdx < 0) break;
    const end = closeIdx + HARMONY_CALL_CLOSE.length;
    parseHarmonyBlock(buffer.slice(start, end), allowed, errors, calls);
    i = end;
  }
  return { calls, errors, nextIndex: i };
}

/** Parse complete Harmony tool-call messages from assistant text. */
export function parseHarmonyToolCalls(
  text: string,
  allowed: ReadonlySet<string>,
): { calls: ParsedHarmonyToolCall[]; rest: string; errors: string[] } {
  const { calls, errors, nextIndex } = drainCompleteHarmonyToolCalls(text, allowed, 0);
  let rest = text;
  const consumed: string[] = [];
  let scan = 0;
  while (scan < nextIndex) {
    const tail = text.slice(scan);
    const relOpen = findHarmonyOpen(tail);
    if (relOpen < 0) break;
    const start = scan + relOpen;
    const closeIdx = text.indexOf(HARMONY_CALL_CLOSE, start);
    if (closeIdx < 0) break;
    const end = closeIdx + HARMONY_CALL_CLOSE.length;
    consumed.push(text.slice(start, end));
    scan = end;
  }
  for (const block of consumed) rest = rest.replace(block, "");
  return { calls, rest: rest.trim(), errors };
}

/** System / developer-style appendix advertising tools in Harmony TypeScript form. */
export function renderHarmonyToolInstructions(specs: ToolSpec[]): string {
  if (specs.length === 0) return "";
  const lines: string[] = [
    "# Tools",
    "",
    "## functions",
    "",
    "namespace functions {",
    "",
  ];
  for (const s of specs) {
    if (s.description) lines.push(`// ${s.description}`);
    const props = (s.parameters?.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(props);
    if (keys.length === 0) {
      lines.push(`type ${s.name} = () => any;`);
    } else {
      lines.push(`type ${s.name} = (_: {`);
      for (const key of keys) {
        lines.push(`${key}?: any,`);
      }
      lines.push(`}) => any;`);
    }
    lines.push("");
  }
  lines.push("} // namespace functions");
  lines.push("");
  lines.push("Calls to these tools must go to the commentary channel: 'functions'.");
  lines.push("Emit each call as a complete Harmony message ending in <|call|>, for example:");
  lines.push(
    `<|start|>assistant<|channel|>commentary to=functions.TOOL_NAME<|message|>{"key":"value"}<|call|>`,
  );
  return lines.join("\n");
}

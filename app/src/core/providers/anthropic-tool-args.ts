/**
 * H-5 provider-shape util: Anthropic tool-call argument repair.
 *
 * - `anthropicToolInput` — contract JSON-string `arguments` → `tool_use.input`
 *   for message replay (fail closed to `{}`).
 * - `anthropicToolArguments` — streamed `input_json_delta` raw + start-block
 *   `declared` → contract JSON-string `arguments` (empty stream falls back to
 *   a non-empty declared object via `toolArgsJson`; never `""`).
 *
 * Kept outside adapter message / SSE loops (same H-5 posture as rulings
 * **67** / **199** / **469**; mini-swe item 40).
 */

import { toolArgsJson } from "./tool-args-object";

/** Contract tool-call `arguments` (JSON string) → Anthropic `tool_use.input`. */
export function anthropicToolInput(text: unknown): unknown {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The JSON a tool block carries. Anthropic announces the block with
 * `input:{}` and streams the object as `input_json_delta`s; a tool with no
 * arguments sends no deltas at all, and a server may put the whole object in
 * the start block. The contract says `arguments` is a JSON string, so a block
 * that streamed nothing falls back to what it declared, never to "".
 */
export function anthropicToolArguments(raw: string, declared: unknown): string {
  if (raw.trim() !== "") return raw;
  // Route the declared-object fallback through the single-purpose util (byte-
  // identical for objects, fail-closed to "{}" for anything else).
  return toolArgsJson(declared);
}

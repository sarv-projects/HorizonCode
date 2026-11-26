/**
 * H-5 provider-shape util: contract tool-call `arguments` (JSON string) →
 * plain object for Google / Ollama (and similar) wire replay. Fail closed to
 * `{}`. Kept outside adapter message / SSE loops.
 */

import type { ToolInputError } from "../../contracts";
import { boundRawToolArguments } from "./replay-args";

/** Result of strictly parsing final tool-call arguments as a plain JSON object. */
export type StrictToolArgsParseResult =
  | { ok: true; args: Record<string, unknown>; json: string }
  | { ok: false; error: ToolInputError };

/**
 * Track A strict finish parse: strictly `JSON.parse` the accumulated raw
 * argument value and require a plain JSON object `{...}` (rejecting primitives,
 * arrays, null, truncated JSON, and malformed syntax). Empty/whitespace-only
 * strings normalize to `"{}"` (no-argument tool call).
 */
export function strictParseToolArgsObject(raw: unknown): StrictToolArgsParseResult {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    try {
      const json = JSON.stringify(raw);
      return { ok: true, args: raw as Record<string, unknown>, json };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "tool_input_error",
          message: `Failed to serialize tool arguments object: ${err instanceof Error ? err.message : String(err)}`,
          rawInput: boundRawToolArguments(String(raw)),
        },
      };
    }
  }
  if (typeof raw !== "string") {
    const kind = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    let snippet: string;
    try {
      snippet = JSON.stringify(raw) ?? String(raw);
    } catch {
      snippet = String(raw);
    }
    return {
      ok: false,
      error: {
        code: "tool_input_error",
        message: `Tool arguments must be a JSON object (got ${kind})`,
        rawInput: boundRawToolArguments(snippet),
      },
    };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, args: {}, json: "{}" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "tool_input_error",
        message: `Invalid JSON in tool arguments: ${err instanceof Error ? err.message : String(err)}`,
        rawInput: boundRawToolArguments(raw),
      },
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      error: {
        code: "tool_input_error",
        message: `Tool arguments must be a JSON object (got ${kind})`,
        rawInput: boundRawToolArguments(raw),
      },
    };
  }
  return { ok: true, args: parsed as Record<string, unknown>, json: raw };
}

export function toolArgsObject(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unparsable arguments replay as no arguments */
  }
  return {};
}

/**
 * H-5: a streamed argument fragment is "complete" once the accumulator parses
 * as a JSON object. Pure, single-parse, no loop — Ollama calls this from its
 * NDJSON consumer instead of inlining `try { JSON.parse } catch`.
 */
export function isCompleteToolArgsObject(raw: string): boolean {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * H-5: normalize ANY wire tool-args shape to a stable contract JSON string.
 * Google sends an object, Ollama a JSON string (possibly cut off mid-object);
 * a plain object is stringified as-is (byte-identical for compact JSON), while
 * a string / malformed / truncated value is parsed through `toolArgsObject`
 * and fails closed to `"{}"`. Single-purpose, no loop.
 */
export function toolArgsJson(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    try {
      return JSON.stringify(raw);
    } catch {
      return "{}";
    }
  }
  return JSON.stringify(toolArgsObject(raw));
}

/**
 * H-5 provider-shape util: contract tool-call `arguments` (JSON string) →
 * plain object for Google / Ollama (and similar) wire replay. Fail closed to
 * `{}`. Kept outside adapter message / SSE loops.
 */

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

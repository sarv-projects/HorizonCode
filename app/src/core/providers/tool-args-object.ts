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

/**
 * H-5 provider-shape util: extract assistant text from an OpenAI-style delta
 * `content` field (string or multipart array). Kept outside the SSE loop.
 */

export function textFromOpenAiDeltaContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") out += p.text;
    else if (typeof p.text === "string" && (p.type === undefined || p.type === "output_text")) out += p.text;
  }
  return out;
}

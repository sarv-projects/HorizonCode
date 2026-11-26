/**
 * failure-signals.ts — structured failure-signal extraction
 * (opencode provider-error.ts ADAPT). Source: packages/ai/src/provider-error.ts:216-289.
 *
 * Additive helpers: extract provider error codes from JSON bodies/messages,
 * parse AWS `x-amzn-errortype`, RFC 9457 `problem+json` codes, and gateway code
 * labels. Complements (does not replace) `failure-codes.ts`. No new contract.
 */

const CODE_FIELD = /\b(?:code|type|error_code|errorCode|error_type|errorType|reason)\b["']?\s*[:=]\s*["']?([\w-]{3,64})["']?/gi;
export const GATEWAY_CODE_LABEL = /gateway code:\s*([a-z0-9_]+)/i;

/** Extract lowercase provider codes from an arbitrary body/message string. */
export function extractFailureCodes(body: string): string[] {
  const out = new Set<string>();
  if (typeof body !== "string" || body === "") return [];
  CODE_FIELD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_FIELD.exec(body)) !== null) {
    const code = m[1]!.trim().toLowerCase().replace(/[\s.]+/g, "_");
    if (code !== "") out.add(code);
    if (CODE_FIELD.lastIndex >= 8000) break; // bounded scan
  }
  return [...out];
}

/** Parse AWS `x-amzn-errortype` (e.g. "ThrottlingException:uuid" → throttlingexception). */
export function awsErrorType(header: string | undefined | null): string[] {
  if (typeof header !== "string" || header.trim() === "") return [];
  const primary = header.split(":")[0]!.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "");
  return primary === "" ? [] : [primary];
}

/** Extract an RFC 9457 `code` (or `type` fragment) from a problem+json body. */
export function extractRfc9457Code(body: string): string | undefined {
  if (typeof body !== "string" || body.trim() === "") return undefined;
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const code = obj.code ?? (typeof obj.type === "string" ? obj.type.split(/[/#]/).pop() : undefined);
    if (typeof code === "string" && code.trim() !== "" && code !== "about:blank") {
      return code.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    }
  } catch {
    /* not JSON: no structured code */
  }
  return undefined;
}

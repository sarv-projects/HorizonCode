/**
 * openai-compatible.ts — a generic OpenAI chat-completions adapter.
 *
 * One OpenAI-chat-shaped provider parameterized by data — { name, baseUrl,
 * credential } — unlocks DeepSeek / Groq / Together / OpenRouter / xAI / vLLM /
 * NVIDIA-NIM / any compatible host as CONFIG, not code. It mirrors opencode's
 * providers/openai-compatible.ts: the returned Provider.name is the configured
 * host id (e.g. "groq"), NOT the literal "openai-compatible".
 *
 * It reuses openai.ts's wire core (SSE loop, tool-call delta assembly,
 * finish-reason mapping, usage, bounded retry) through `streamOpenAiCompatible`
 * — there is no clone. The only thing this file decides is the Authorization
 * header, which is rendered from the credential (data), never from the provider
 * id (no `id.includes(...)` anywhere).
 */

import type { Credential, Provider, ProviderEvent, ProviderRequest } from "../../contracts";
import { streamOpenAiCompatible } from "./openai";

export interface OpenAiCompatibleOptions {
  /** The real host id that becomes Provider.name (e.g. "groq"), not a literal. */
  name: string;
  /** The endpoint root; the request POSTs to `<baseUrl>/v1/chat/completions`. */
  baseUrl: string;
  /** How the host is authenticated (contracts.ts `Credential`). */
  credential: Credential;
  maxTokens?: number;
}

/**
 * Render the Authorization header value from a credential, or `undefined` for a
 * keyless host. `apiKey` and `oauth` both use a Bearer token; `none` sends no
 * header at all. This is the whole auth policy — a pure function of the
 * credential, never of the provider name.
 */
function authorizationHeader(credential: Credential): string | undefined {
  if (credential.kind === "apiKey") return `Bearer ${credential.value}`;
  if (credential.kind === "oauth") return `Bearer ${credential.accessToken}`;
  return undefined; // kind "none" — a keyless host (e.g. a local vLLM)
}

/**
 * Build a Provider for any OpenAI-chat-compatible host. The returned provider's
 * `name` is the configured host id so logs, banners and errors read as the host
 * itself.
 */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): Provider {
  const authorization = authorizationHeader(opts.credential);
  return {
    name: opts.name,
    stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
      streamOpenAiCompatible({ name: opts.name, baseUrl: opts.baseUrl, maxTokens: opts.maxTokens, authorization }, req),
  };
}

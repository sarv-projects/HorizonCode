/**
 * providers/index.ts — pick the provider the configuration asked for.
 *
 * `mockFlag` (the --mock flag or an empty key) forces the offline provider so the
 * chat always works; a real provider without a key reports that clearly instead
 * of failing with an opaque 401. Ollama is the exception: a local server needs
 * no key, and a refused connection is already the readable error. The mock is
 * reached ONLY through `--mock` or an explicit `HZ_PROVIDER=mock`; an unknown
 * provider id fails loud (it names the id and lists the valid providers) rather
 * than silently becoming a fake offline chat.
 */

import type { Provider, ProviderEvent } from "../../contracts";
import type { HzConfig } from "../config";
import { PROVIDER_NAMES } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createGoogleProvider } from "./google";
import { createMockProvider } from "./mock";
import { createOllamaProvider } from "./ollama";
import { createOpenAiProvider } from "./openai";
import { createOpenAiCompatibleProvider } from "./openai-compatible";

export { createMockProvider, MOCK_GREETING } from "./mock";
export { createAnthropicProvider, toAnthropicMessages, toAnthropicTools } from "./anthropic";
export { createOpenAiProvider, toOpenAiMessages, toOpenAiTools } from "./openai";
export { createOpenAiCompatibleProvider } from "./openai-compatible";
export type { OpenAiCompatibleOptions } from "./openai-compatible";
export { createGoogleProvider, toGoogleContents, toGoogleTools } from "./google";
export { createOllamaProvider, toOllamaMessages, toOllamaTools } from "./ollama";

export interface MakeProviderOptions {
  /** Force the offline mock provider regardless of the configuration. */
  mockFlag?: boolean;
}

/** A provider that explains, in one event, which key is missing. */
function missingKeyProvider(provider: string, envVar: string): Provider {
  const message =
    `No API key for ${provider}. Set HZ_API_KEY or ${envVar}, or run with --mock ` +
    `(or HZ_PROVIDER=mock) to chat offline.`;
  return {
    name: provider,
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "error", message };
      yield { type: "done", stopReason: "end" };
    },
  };
}

/**
 * A provider that explains, in one event, that the configured provider id is
 * not known — then ends the turn cleanly (the same shape as
 * `missingKeyProvider`). This is the fail-loud default: a typo in HZ_PROVIDER
 * must never silently become the offline mock chat.
 */
function unknownProviderProvider(id: string, validNames: readonly string[]): Provider {
  const message =
    `Unknown provider "${id}". Valid providers are: ${validNames.join(", ")} ` +
    `(plus any provider registered in your config). ` +
    `Check HZ_PROVIDER, or run with --mock (or HZ_PROVIDER=mock) to chat offline.`;
  return {
    name: id,
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "error", message };
      yield { type: "done", stopReason: "end" };
    },
  };
}

/** The provider the runtime will talk to. */
export function makeProvider(config: HzConfig, opts: MakeProviderOptions = {}): Provider {
  if (opts.mockFlag) return createMockProvider();

  // A registered (config-declared) provider resolves to the generic
  // openai-compatible adapter — endpoint + credential as DATA, never code. An
  // entry that wanted a key but could not find one reports it the same way a
  // built-in does; a keyless entry (kind "none", no key declared) streams.
  const resolved = config.resolved;
  if (resolved) {
    if (resolved.credential.kind === "none" && resolved.wantsKey) {
      return missingKeyProvider(resolved.name, "HZ_API_KEY or the provider's envKey");
    }
    return createOpenAiCompatibleProvider({ name: resolved.name, baseUrl: resolved.baseUrl, credential: resolved.credential });
  }

  switch (config.provider) {
    case "anthropic":
      return config.apiKey
        ? createAnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
        : missingKeyProvider("anthropic", "ANTHROPIC_API_KEY");
    case "openai":
      return config.apiKey
        ? createOpenAiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
        : missingKeyProvider("openai", "OPENAI_API_KEY");
    case "google":
      return config.apiKey
        ? createGoogleProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
        : missingKeyProvider("google", "GEMINI_API_KEY or GOOGLE_API_KEY");
    case "ollama":
      // No key required: a local server (a key only fronts a proxy deployment).
      return createOllamaProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    case "mock":
      return createMockProvider();
    default:
      // Fail loud: an unknown id (a typo'd HZ_PROVIDER) is reported, never
      // silently turned into the offline mock. The mock is only reachable via
      // the --mock flag (above) or an explicit `case "mock"`.
      return unknownProviderProvider(config.provider, PROVIDER_NAMES);
  }
}

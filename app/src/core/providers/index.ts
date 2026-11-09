/**
 * providers/index.ts — pick the provider the configuration asked for.
 *
 * `mockFlag` (the --mock flag or an empty key) forces the offline provider so the
 * chat always works; a real provider without a key reports that clearly instead
 * of failing with an opaque 401. Ollama is the exception: a local server needs
 * no key, and a refused connection is already the readable error.
 */

import type { Provider, ProviderEvent } from "../../contracts";
import type { HzConfig } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createGoogleProvider } from "./google";
import { createMockProvider } from "./mock";
import { createOllamaProvider } from "./ollama";
import { createOpenAiProvider } from "./openai";

export { createMockProvider, MOCK_GREETING } from "./mock";
export { createAnthropicProvider, toAnthropicMessages, toAnthropicTools } from "./anthropic";
export { createOpenAiProvider, toOpenAiMessages, toOpenAiTools } from "./openai";
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

/** The provider the runtime will talk to. */
export function makeProvider(config: HzConfig, opts: MakeProviderOptions = {}): Provider {
  if (opts.mockFlag) return createMockProvider();
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
    default:
      return createMockProvider();
  }
}

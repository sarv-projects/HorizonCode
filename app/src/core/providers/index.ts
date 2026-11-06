/**
 * providers/index.ts — pick the provider the configuration asked for.
 *
 * `mockFlag` (the --mock flag or an empty key) forces the offline provider so the
 * chat always works; a real provider without a key reports that clearly instead
 * of failing with an opaque 401.
 */

import type { Provider, ProviderEvent } from "../../contracts";
import type { HzConfig } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import { createOpenAiProvider } from "./openai";

export { createMockProvider, MOCK_GREETING } from "./mock";
export { createAnthropicProvider, toAnthropicMessages, toAnthropicTools } from "./anthropic";
export { createOpenAiProvider, toOpenAiMessages, toOpenAiTools } from "./openai";

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
    default:
      return createMockProvider();
  }
}

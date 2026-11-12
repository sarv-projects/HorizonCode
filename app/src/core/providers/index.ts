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
import { wrapAnthropicToolProvider } from "./toolconv/wrap-anthropic";
import { wrapDeepseekToolProvider } from "./toolconv/wrap-deepseek";
import { wrapGemmaToolProvider } from "./toolconv/wrap-gemma";
import { wrapGeminiToolProvider } from "./toolconv/wrap-gemini";
import { wrapGlmToolProvider } from "./toolconv/wrap-glm";
import { wrapHarmonyToolProvider } from "./toolconv/wrap-harmony";
import { wrapHermesToolProvider } from "./toolconv/wrap-hermes";
import { wrapKimiToolProvider } from "./toolconv/wrap-kimi";
import { wrapMinimaxToolProvider } from "./toolconv/wrap-minimax";
import { wrapQwen3ToolProvider } from "./toolconv/wrap-qwen3";
import { wrapXmlToolProvider } from "./toolconv/wrap-xml";

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

/**
 * A provider that explains, in one event, that a registered host has no model
 * configured — then ends the turn cleanly (the same shape as
 * `missingKeyProvider`). Forwarding a placeholder model id (historically the
 * mock's `mock-1`) to a real host yields an opaque 400/404; this is the
 * fail-loud guard that keeps that silent-wrong-thing from reaching the wire.
 */
function noModelProvider(provider: string): Provider {
  const message =
    `No model configured for "${provider}". Set HZ_MODEL or add a models[] ` +
    `entry to the provider in your config.`;
  return {
    name: provider,
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "error", message };
      yield { type: "done", stopReason: "end" };
    },
  };
}

function withToolFormat(provider: Provider, config: HzConfig): Provider {
  if (config.toolFormat === "xml") return wrapXmlToolProvider(provider);
  if (config.toolFormat === "hermes") return wrapHermesToolProvider(provider);
  if (config.toolFormat === "qwen3") return wrapQwen3ToolProvider(provider);
  if (config.toolFormat === "harmony") return wrapHarmonyToolProvider(provider);
  if (config.toolFormat === "kimi") return wrapKimiToolProvider(provider);
  if (config.toolFormat === "glm") return wrapGlmToolProvider(provider);
  if (config.toolFormat === "deepseek") return wrapDeepseekToolProvider(provider);
  if (config.toolFormat === "gemini") return wrapGeminiToolProvider(provider);
  if (config.toolFormat === "gemma") return wrapGemmaToolProvider(provider);
  if (config.toolFormat === "minimax") return wrapMinimaxToolProvider(provider);
  if (config.toolFormat === "anthropic") return wrapAnthropicToolProvider(provider);
  return provider;
}

/** The provider the runtime will talk to. */
export function makeProvider(config: HzConfig, opts: MakeProviderOptions = {}): Provider {
  if (opts.mockFlag) return withToolFormat(createMockProvider(), config);

  // A registered (config-declared) provider resolves to the generic
  // openai-compatible adapter — endpoint + credential as DATA, never code. An
  // entry that wanted a key but could not find one reports it the same way a
  // built-in does; a keyless entry (kind "none", no key declared) streams. An
  // entry with no model configured fails loud rather than forwarding a
  // placeholder id to the real host.
  const resolved = config.resolved;
  if (resolved) {
    if (resolved.credential.kind === "none" && resolved.wantsKey) {
      return missingKeyProvider(resolved.name, "HZ_API_KEY or the provider's envKey");
    }
    if (config.model === "") {
      return noModelProvider(resolved.name);
    }
    const home = typeof process.env.HOME === "string" && process.env.HOME !== "" ? process.env.HOME : undefined;
    return withToolFormat(
      createOpenAiCompatibleProvider({
        name: resolved.name,
        baseUrl: resolved.baseUrl,
        credential: resolved.credential,
        oauth: resolved.oauth,
        home,
      }),
      config,
    );
  }

  switch (config.provider) {
    case "anthropic":
      return withToolFormat(
        config.apiKey
          ? createAnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
          : missingKeyProvider("anthropic", "ANTHROPIC_API_KEY"),
        config,
      );
    case "openai":
      return withToolFormat(
        config.apiKey
          ? createOpenAiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
          : missingKeyProvider("openai", "OPENAI_API_KEY"),
        config,
      );
    case "google":
      return withToolFormat(
        config.apiKey
          ? createGoogleProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })
          : missingKeyProvider("google", "GEMINI_API_KEY or GOOGLE_API_KEY"),
        config,
      );
    case "ollama":
      // No key required: a local server (a key only fronts a proxy deployment).
      return withToolFormat(createOllamaProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl }), config);
    case "mock":
      return withToolFormat(createMockProvider(), config);
    default:
      // Fail loud: an unknown id (a typo'd HZ_PROVIDER) is reported, never
      // silently turned into the offline mock. The mock is only reachable via
      // the --mock flag (above) or an explicit `case "mock"`.
      return unknownProviderProvider(config.provider, PROVIDER_NAMES);
  }
}

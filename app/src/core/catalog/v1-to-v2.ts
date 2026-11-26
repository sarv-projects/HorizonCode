/**
 * v1-to-v2.ts — pure, zero-dependency converter from models.dev v1 (`/api.json`)
 * to models.dev v2 (`/experimental/v2.0/api.json?type=chat`) shape.
 *
 * Mirrors OpenCode's `models-dev/v1.ts` normalization so both v1 and v2
 * payloads decode through the single tolerant `decodeCatalog` pipeline into
 * the same rich `Catalog` shape.
 *
 * Invariants:
 *  - Zero runtime dependencies.
 *  - R50 cost honesty: missing or non-per-token cost stays `undefined`, never `0`.
 *  - Explicit `0` per-token cost (e.g. free/NVIDIA-hosted models) is preserved.
 */

export type CatalogProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-gemini"
  | "ollama";

export const SUPPORTED_CATALOG_PROTOCOLS: readonly CatalogProviderProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
  "ollama",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Normalize an OpenCode/AI SDK package specifier (mirrors OpenCode's
 * `aisdk-native.ts` `packageName()`): strips `aisdk:` prefix and normalizes
 * `@opencode-ai/ai/` -> `@opencode/ai/`.
 */
export function normalizeSdkPackageName(raw: unknown): string | undefined {
  const s = nonEmptyString(raw);
  if (!s) return undefined;
  let normalized = s.trim();
  if (normalized.startsWith("aisdk:")) normalized = normalized.slice("aisdk:".length);
  if (normalized.startsWith("@opencode-ai/ai/")) {
    normalized = normalized.replace("@opencode-ai/", "@opencode/");
  }
  return normalized.toLowerCase();
}

/**
 * Map a models.dev v1 `npm` package id, v2 `api.<protocol>` key, or OpenCode
 * `@opencode/ai/providers/*` entrypoint to one of HorizonCode's 5 zero-dep wire
 * protocols. Mirrors OpenCode's `provider.ts` + `aisdk-native.ts` package table.
 * Returns `undefined` when unrecognized (fail closed — never silently coerce).
 */
export function mapProtocolIdentifier(raw: unknown): CatalogProviderProtocol | undefined {
  const s = normalizeSdkPackageName(raw);
  if (!s) return undefined;

  if (
    s === "openai-chat" ||
    s === "openai-responses" ||
    s === "anthropic-messages" ||
    s === "google-gemini" ||
    s === "ollama"
  ) {
    return s;
  }

  // Non-chat-only OpenCode/models.dev endpoints (images/embeddings/decisions/etc.)
  // do not map to a chat wire protocol.
  if (
    s === "images" ||
    s === "decisions" ||
    s === "embeddings" ||
    s === "moderations" ||
    s === "ocr" ||
    s === "fim" ||
    s.endsWith("/images") ||
    s.endsWith("/decisions") ||
    s.endsWith("/embeddings")
  ) {
    return undefined;
  }

  // Anthropic Messages protocol (native + OpenCode + AI SDK).
  if (
    s === "messages" ||
    s === "anthropic" ||
    s === "@ai-sdk/anthropic" ||
    s === "@ai-sdk/google-vertex/anthropic" ||
    s === "@opencode/ai/providers/anthropic" ||
    s === "@opencode/ai/providers/anthropic-compatible" ||
    s === "@opencode/ai/providers/google-vertex-messages" ||
    (s.startsWith("@opencode/ai/providers/") && s.endsWith("/messages"))
  ) {
    return "anthropic-messages";
  }

  // OpenAI Responses protocol (native + OpenCode + AI SDK).
  if (
    s === "responses" ||
    s === "openai" ||
    s === "@ai-sdk/openai" ||
    s === "@ai-sdk/azure" ||
    s === "@ai-sdk/xai" ||
    s === "@ai-sdk/open-responses" ||
    s === "@opencode/ai/providers/openai" ||
    s === "@opencode/ai/providers/azure" ||
    s === "@opencode/ai/providers/xai" ||
    s === "@opencode/ai/providers/openai-compatible-responses" ||
    s === "@opencode/ai/providers/google-vertex-responses" ||
    (s.startsWith("@opencode/ai/providers/") && s.endsWith("/responses"))
  ) {
    return "openai-responses";
  }

  // Google Gemini protocol (native + OpenCode + AI SDK).
  if (
    s === "generate-content" ||
    s === "interactions" ||
    s === "google" ||
    s === "gemini" ||
    s === "@ai-sdk/google" ||
    s === "@ai-sdk/google-vertex" ||
    s === "@opencode/ai/providers/google" ||
    s === "@opencode/ai/providers/google/interactions" ||
    s === "@opencode/ai/providers/google-vertex" ||
    s === "@opencode/ai/providers/google-vertex/gemini" ||
    s === "@opencode/ai/providers/google-vertex/interactions" ||
    s === "@opencode/ai/providers/google-vertex-interactions"
  ) {
    return "google-gemini";
  }

  // Ollama native protocol.
  if (s === "ollama-ai-provider" || s === "ai-sdk-ollama" || s === "ollama-ai-provider-v2") {
    return "ollama";
  }

  // OpenAI Chat Completions compatible SDKs, gateways, and OpenCode providers.
  if (
    s === "chat-completions" ||
    s === "cohere-chat" ||
    s === "workers-ai-run" ||
    s === "converse" ||
    s === "systemone" ||
    s === "@ai-sdk/openai-compatible" ||
    s === "openai-compatible" ||
    s === "@openrouter/ai-sdk-provider" ||
    s === "@ai-sdk/groq" ||
    s === "@ai-sdk/deepseek" ||
    s === "@ai-sdk/mistral" ||
    s === "@ai-sdk/togetherai" ||
    s === "@ai-sdk/fireworks" ||
    s === "@ai-sdk/perplexity" ||
    s === "@ai-sdk/cerebras" ||
    s === "@ai-sdk/deepinfra" ||
    s === "@ai-sdk/nvidia" ||
    s === "@ai-sdk/cohere" ||
    s === "@ai-sdk/alibaba" ||
    s === "@ai-sdk/gateway" ||
    s === "@ai-sdk/amazon-bedrock" ||
    s === "@ai-sdk/amazon-bedrock/mantle" ||
    s === "@ai-sdk/typesafe-ai" ||
    s === "ai-gateway-provider" ||
    s === "venice-ai-sdk-provider" ||
    s === "@aihubmix/ai-sdk-provider" ||
    s === "@jerome-benoit/sap-ai-provider-v2" ||
    s === "@qvac/ai-sdk-provider" ||
    s === "@saladtechnologies-oss/ai-sdk-provider" ||
    s === "gitlab-ai-provider" ||
    s === "merge-gateway-ai-sdk-provider" ||
    s === "watsonx-ai-provider" ||
    s.startsWith("@opencode/ai/providers/")
  ) {
    return "openai-chat";
  }

  return undefined;
}

export interface ResolvedApiRoute {
  protocol: CatalogProviderProtocol;
  baseUrl?: string;
  compatibility?: Record<string, unknown>;
  headers?: Record<string, string>;
  sdkPackage?: string;
}

const PREFERRED_API_KEYS = new Set([
  "chat-completions",
  "responses",
  "messages",
  "generate-content",
  "interactions",
  "cohere-chat",
  "converse",
  "workers-ai-run",
  "systemone",
]);

/**
 * Resolve the primary wire route from a models.dev v2 `model.api` ordered map
 * (`{ [protocolKey]: { base_url, sdk: { opencodeai, aisdk }, compatibility, headers } }`).
 * Mirrors OpenCode's `route()` in `packages/core/src/models-dev.ts`: selects the
 * first chat-capable API entry in declaration order.
 */
export function resolveApiRoute(rawApi: unknown): ResolvedApiRoute | undefined {
  const apiMap = asRecord(rawApi);
  if (!apiMap) return undefined;

  const entries = Object.entries(apiMap);
  // First pass: prefer standard chat-capable API keys in declaration order.
  // Second pass: accept any entry whose SDK/key maps to a supported protocol.
  for (const preferredOnly of [true, false]) {
    for (const [apiKey, entryVal] of entries) {
      if (preferredOnly && !PREFERRED_API_KEYS.has(apiKey.toLowerCase())) continue;
      const entry = asRecord(entryVal);
      if (!entry) continue;
      const sdk = asRecord(entry.sdk);
      const opencodeai = nonEmptyString(sdk?.opencodeai);
      const aisdk = nonEmptyString(sdk?.aisdk);
      const protocol =
        mapProtocolIdentifier(opencodeai) ??
        mapProtocolIdentifier(apiKey) ??
        mapProtocolIdentifier(aisdk);
      if (!protocol) continue;

      const baseUrl = nonEmptyString(entry.base_url ?? entry.baseUrl);
      const compatRaw = asRecord(entry.compatibility);
      const compatibility: Record<string, unknown> = {};
      if (compatRaw) {
        for (const [k, v] of Object.entries(compatRaw)) {
          if (v !== undefined) compatibility[k] = v;
        }
      }
      const headersRaw = asRecord(entry.headers);
      let headers: Record<string, string> | undefined;
      if (headersRaw) {
        const parsed: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(headersRaw)) {
          if (typeof hv === "string" && hv.trim() !== "") parsed[hk] = hv;
        }
        if (Object.keys(parsed).length > 0) headers = parsed;
      }
      const sdkPackage = opencodeai ?? aisdk;
      return {
        protocol,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(Object.keys(compatibility).length > 0 ? { compatibility } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(sdkPackage !== undefined ? { sdkPackage } : {}),
      };
    }
  }
  return undefined;
}

function hasV2ModelShape(model: Record<string, unknown>): boolean {
  const caps = asRecord(model.capabilities);
  if (caps) {
    if (
      asRecord(caps.tools) !== undefined ||
      asRecord(caps.reasoning) !== undefined ||
      asRecord(caps.cache) !== undefined ||
      asRecord(caps.structured_output) !== undefined ||
      asRecord(caps.structuredOutput) !== undefined
    ) {
      return true;
    }
  }
  const cost = asRecord(model.cost);
  if (cost && asRecord(cost.text) !== undefined) return true;
  return false;
}

function hasV1ModelMarkers(model: Record<string, unknown>): boolean {
  if ("tool_call" in model) return true;
  if ("attachment" in model) return true;
  if ("structured_output" in model) return true;
  if ("release_date" in model) return true;
  if ("interleaved" in model) return true;
  if (typeof model.reasoning === "boolean" && asRecord(model.capabilities) === undefined) return true;
  if (typeof model.temperature === "boolean" && asRecord(model.capabilities) === undefined) return true;
  return false;
}

/**
 * Detect whether a parsed JSON catalog payload is in models.dev v1 format
 * (`/api.json`) rather than v2 (`/experimental/v2.0/api.json?type=chat`) or
 * HorizonCode's already-normalized curated/snapshot format.
 */
export function isV1Catalog(value: unknown): boolean {
  const top = asRecord(value);
  if (!top) return false;

  const container = asRecord(top.providers) ?? top;
  let sawV1 = false;
  let inspected = 0;

  for (const [key, entry] of Object.entries(container)) {
    if (key.startsWith("$")) continue;
    const prov = asRecord(entry);
    if (!prov) continue;
    inspected += 1;

    const models = asRecord(prov.models);
    if (models) {
      for (const modelVal of Object.values(models)) {
        const model = asRecord(modelVal);
        if (!model) continue;
        if (hasV2ModelShape(model)) return false;
        if (hasV1ModelMarkers(model)) sawV1 = true;
      }
    }

    if (typeof prov.npm === "string" || typeof prov.api === "string") {
      sawV1 = true;
    }

    if (inspected >= 25 && sawV1) return true;
  }

  return sawV1;
}

function normalizeV1CostToV2(rawCost: unknown): Record<string, unknown> | undefined {
  const cost = asRecord(rawCost);
  if (!cost) return undefined;

  const input = finite(cost.input);
  const output = finite(cost.output);
  const cacheRead = finite(cost.cache_read ?? cost.cacheRead);
  const cacheWrite = finite(cost.cache_write ?? cost.cacheWrite);

  const overrides: Array<Record<string, unknown>> = [];

  if (Array.isArray(cost.tiers)) {
    for (const rawTier of cost.tiers) {
      const t = asRecord(rawTier);
      if (!t) continue;
      const tierMeta = asRecord(t.tier);
      const size = finite(tierMeta?.size ?? t.size ?? t.context_over);
      if (size === undefined) continue;
      const ov: Record<string, unknown> = { condition: { context_over: size } };
      const ti = finite(t.input);
      const to = finite(t.output);
      const tr = finite(t.cache_read ?? t.cacheRead);
      const tw = finite(t.cache_write ?? t.cacheWrite);
      if (ti !== undefined) ov.input = ti;
      if (to !== undefined) ov.output = to;
      if (tr !== undefined) ov.cache_read = tr;
      if (tw !== undefined) ov.cache_write = tw;
      if (ti !== undefined || to !== undefined || tr !== undefined || tw !== undefined) {
        overrides.push(ov);
      }
    }
  }

  const over200k = asRecord(cost.context_over_200k);
  if (over200k) {
    const ti = finite(over200k.input);
    const to = finite(over200k.output);
    const tr = finite(over200k.cache_read ?? over200k.cacheRead);
    const tw = finite(over200k.cache_write ?? over200k.cacheWrite);
    if (ti !== undefined || to !== undefined || tr !== undefined || tw !== undefined) {
      const ov: Record<string, unknown> = { condition: { context_over: 200_000 } };
      if (ti !== undefined) ov.input = ti;
      if (to !== undefined) ov.output = to;
      if (tr !== undefined) ov.cache_read = tr;
      if (tw !== undefined) ov.cache_write = tw;
      overrides.push(ov);
    }
  }

  const text: Record<string, unknown> = {};
  if (input !== undefined) text.input = input;
  if (output !== undefined) text.output = output;
  if (cacheRead !== undefined) text.cache_read = cacheRead;
  if (cacheWrite !== undefined) text.cache_write = cacheWrite;
  if (overrides.length > 0) text.overrides = overrides;

  // R50: if there are no per-token cost numbers, omit `cost` completely.
  if (Object.keys(text).length === 0) return undefined;
  return { text };
}

function normalizeV1Modalities(raw: unknown): { input?: string[]; output?: string[] } | undefined {
  const m = asRecord(raw);
  if (!m) return undefined;
  const out: { input?: string[]; output?: string[] } = {};
  if (Array.isArray(m.input)) {
    const items = m.input.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out.input = items;
  }
  if (Array.isArray(m.output)) {
    const items = m.output.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out.output = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeV1Model(key: string, rawModel: unknown): unknown {
  const m = asRecord(rawModel);
  if (!m) return rawModel;

  const out: Record<string, unknown> = {
    id: nonEmptyString(m.id) ?? key,
  };

  const name = nonEmptyString(m.name);
  if (name !== undefined) out.name = name;
  const family = nonEmptyString(m.family);
  if (family !== undefined) out.family = family;
  const status = nonEmptyString(m.status);
  if (status !== undefined) out.status = status;
  const releasedAt = nonEmptyString(m.release_date ?? m.releasedAt);
  if (releasedAt !== undefined) out.releasedAt = releasedAt;

  const modalities = normalizeV1Modalities(m.modalities);
  if (modalities !== undefined) out.modalities = modalities;

  if (m.limit !== undefined) out.limit = m.limit;

  // Build v2-shaped capabilities.
  const capabilities: Record<string, unknown> = {};
  if (typeof m.tool_call === "boolean") {
    capabilities.tools = { supported: m.tool_call };
  }
  if (typeof m.reasoning === "boolean") {
    const reasoningCap: Record<string, unknown> = { supported: m.reasoning };
    if (typeof m.interleaved === "boolean") {
      reasoningCap.interleaved = m.interleaved;
    } else {
      const inter = asRecord(m.interleaved);
      const field = nonEmptyString(inter?.field);
      if (field !== undefined) reasoningCap.interleaved = { field };
    }
    capabilities.reasoning = reasoningCap;
  }
  if (typeof m.temperature === "boolean") {
    capabilities.temperature = m.temperature;
  }
  if (typeof m.structured_output === "boolean") {
    capabilities.structured_output = { supported: m.structured_output };
  }
  const hasImageModality = modalities?.input?.includes("image");
  if (hasImageModality === true) {
    capabilities.vision = true;
  } else if (typeof m.attachment === "boolean") {
    capabilities.vision = m.attachment;
  }

  const rawCost = asRecord(m.cost);
  if (rawCost && finite(rawCost.cache_write ?? rawCost.cacheWrite) !== undefined) {
    capabilities.cache = { explicit: true };
  }

  if (Object.keys(capabilities).length > 0) out.capabilities = capabilities;

  const v2Cost = normalizeV1CostToV2(m.cost);
  if (v2Cost !== undefined) out.cost = v2Cost;

  // Per-model provider overrides (`model.provider: { npm, api }` in v1).
  const modelProv = asRecord(m.provider);
  if (modelProv) {
    const proto = mapProtocolIdentifier(modelProv.protocol ?? modelProv.npm);
    if (proto !== undefined) out.protocol = proto;
    const baseUrl = nonEmptyString(modelProv.api ?? modelProv.baseUrl);
    if (baseUrl !== undefined) out.baseUrl = baseUrl;
  }

  // Compatibility bag (interleaved, headers, options, open_weights).
  const compatibility: Record<string, unknown> = {};
  if (m.interleaved !== undefined) compatibility.interleaved = m.interleaved;
  if (asRecord(m.headers)) compatibility.headers = m.headers;
  if (asRecord(m.options)) compatibility.options = m.options;
  if (typeof m.open_weights === "boolean") compatibility.openWeights = m.open_weights;
  if (Object.keys(compatibility).length > 0) out.compatibility = compatibility;

  if (m.accepts_settings !== undefined) out.accepts_settings = m.accepts_settings;
  if (m.acceptsSettings !== undefined) out.acceptsSettings = m.acceptsSettings;

  return out;
}

/**
 * Normalize a models.dev v1 (`/api.json`) payload into the v2 shape expected
 * by `decodeCatalog()`. Non-v1 or malformed values are returned tolerantly so
 * `decodeCatalog()` can handle them uniformly.
 */
export function normalizeV1ToV2(value: unknown): Record<string, unknown> {
  const top = asRecord(value);
  if (!top) return {};
  const source = asRecord(top.providers) ?? top;
  const providers: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(source)) {
    if (key.startsWith("$")) continue;
    const prov = asRecord(entry);
    if (!prov) {
      providers[key] = entry;
      continue;
    }

    const id = nonEmptyString(prov.id) ?? key;
    const outProv: Record<string, unknown> = { id };

    const name = nonEmptyString(prov.name);
    if (name !== undefined) outProv.name = name;

    if (Array.isArray(prov.env)) {
      const envVars = prov.env
        .filter((e): e is string => typeof e === "string" && e.trim() !== "")
        .map((e) => e.trim());
      if (envVars.length > 0) outProv.env = envVars;
    }

    const baseUrl = nonEmptyString(prov.baseUrl ?? prov.api);
    if (baseUrl !== undefined) outProv.baseUrl = baseUrl;

    const protocol = mapProtocolIdentifier(prov.protocol ?? prov.npm);
    if (protocol !== undefined) outProv.protocol = protocol;

    const defaultModel = nonEmptyString(prov.defaultModel);
    if (defaultModel !== undefined) outProv.defaultModel = defaultModel;

    const rawModels = asRecord(prov.models);
    if (rawModels) {
      const models: Record<string, unknown> = {};
      for (const [mKey, mVal] of Object.entries(rawModels)) {
        models[mKey] = normalizeV1Model(mKey, mVal);
      }
      outProv.models = models;
    } else if (prov.models !== undefined) {
      outProv.models = prov.models;
    }

    providers[id] = outProv;
  }

  return providers;
}

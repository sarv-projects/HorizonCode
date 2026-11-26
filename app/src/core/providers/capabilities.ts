/**
 * capabilities.ts -- provider-level capability descriptor (plan Task 4).
 *
 * Data-driven only: no provider/model-id string matching. Model-level
 * capabilities live in core/catalog/catalog.ts and are a different layer.
 */

import type { ProviderCapabilities } from "../../contracts";

export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  thinking: false,
  usage: false,
  toolCallIds: false,
  partialJson: false,
  steer: false,
};

const CAPABILITY_KEYS = [
  "streaming",
  "tools",
  "thinking",
  "usage",
  "toolCallIds",
  "partialJson",
  "steer",
] as const;

/**
 * Endpoint-specific overrides are data. Keys are provider ids; an optional
 * baseUrl substring (data, not a model id) selects a gateway-specific row.
 */
const PROVIDER_ROWS: ReadonlyArray<{
  provider: string;
  baseUrlContains?: string;
  capabilities: Partial<ProviderCapabilities>;
}> = [
  { provider: "openai", capabilities: { usage: true, toolCallIds: true, partialJson: true } },
  { provider: "anthropic", capabilities: { thinking: true, usage: true, toolCallIds: true } },
  { provider: "google", capabilities: { usage: true } },
];

export interface ProviderCapabilityInput {
  provider: string;
  baseUrl?: string;
  declared?: Partial<ProviderCapabilities>;
}

export function resolveProviderCapabilities(input: ProviderCapabilityInput): ProviderCapabilities {
  const result: ProviderCapabilities = { ...DEFAULT_PROVIDER_CAPABILITIES };
  const provider = input.provider.toLowerCase();
  for (const row of PROVIDER_ROWS) {
    if (row.provider !== provider) continue;
    if (row.baseUrlContains !== undefined && !(input.baseUrl ?? "").includes(row.baseUrlContains)) continue;
    for (const key of CAPABILITY_KEYS) {
      const value = row.capabilities[key];
      if (value !== undefined) result[key] = value;
    }
  }
  for (const key of CAPABILITY_KEYS) {
    const value = input.declared?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

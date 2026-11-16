import { DEFAULT_MODELS, type HzConfig, type ProviderName } from "../config";
import { loadCatalog, type Catalog } from "./catalog";

/**
 * Model ids for a provider: the user registry first, then the loaded catalog.
 *
 * A built-in provider also lists its resolved default even when the catalog is
 * cold (no snapshot, no cache, offline). The runtime WILL send that model id
 * when nothing else is configured, so `/models` claiming "none" would be a lie
 * — and it is the common case for `mock` and for a fresh install.
 */
export function modelsForProvider(provider: string, config: Pick<HzConfig, "providers">, catalog: Catalog = loadCatalog()): string[] {
  const registryEntry = config.providers?.providers.find((p) => p.id === provider);
  const fromCatalog = catalog.providers[provider];
  const ids = new Set<string>();
  if (Object.hasOwn(DEFAULT_MODELS, provider)) ids.add(DEFAULT_MODELS[provider as ProviderName]);
  for (const m of registryEntry?.models ?? []) ids.add(m);
  if (fromCatalog !== undefined) {
    for (const id of Object.keys(fromCatalog.models)) ids.add(id);
  }
  return [...ids].sort();
}

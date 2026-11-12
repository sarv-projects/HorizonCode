import type { HzConfig } from "../config";
import { loadCatalog, type Catalog } from "./catalog";

/** Model ids for a provider from the user registry and the loaded catalog. */
export function modelsForProvider(provider: string, config: Pick<HzConfig, "providers">, catalog: Catalog = loadCatalog()): string[] {
  const registryEntry = config.providers?.providers.find((p) => p.id === provider);
  const fromCatalog = catalog.providers[provider];
  const ids = new Set<string>();
  for (const m of registryEntry?.models ?? []) ids.add(m);
  if (fromCatalog !== undefined) {
    for (const id of Object.keys(fromCatalog.models)) ids.add(id);
  }
  return [...ids].sort();
}

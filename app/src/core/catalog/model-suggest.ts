/**
 * Model id discovery and typo suggestions (docs/30 I-8; aider fuzzy list-models).
 */

import type { HzConfig } from "../config";
import { DEFAULT_MODELS } from "../config";
import { catalogModel, type Catalog } from "./catalog";
import { modelsForProvider } from "./list-models";

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function similarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;
  if (al.includes(bl) || bl.includes(al)) return 0.92;
  const max = Math.max(al.length, bl.length);
  if (max === 0) return 1;
  return 1 - levenshtein(al, bl) / max;
}

/** Every model id visible for the active provider (registry ∪ catalog ∪ built-in default), sorted. */
export function modelIdsForProvider(provider: string, config: Pick<HzConfig, "providers">, catalog: Catalog): string[] {
  const ids = new Set(modelsForProvider(provider, config, catalog));
  if (Object.prototype.hasOwnProperty.call(DEFAULT_MODELS, provider)) {
    ids.add(DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS]);
  }
  return [...ids].sort();
}

/** All ids in the catalog plus registry `models[]` entries (deduped, sorted). */
export function allCatalogModelIds(config: Pick<HzConfig, "providers">, catalog: Catalog): string[] {
  const ids = new Set<string>();
  for (const p of Object.values(catalog.providers)) {
    for (const id of Object.keys(p.models)) ids.add(id);
  }
  for (const entry of config.providers?.providers ?? []) {
    for (const id of entry.models ?? []) ids.add(id);
  }
  return [...ids].sort();
}

/** Whether `model` is a configured or catalog-known id for this provider (I-8 reduced). */
export function isKnownModel(provider: string, model: string, config: Pick<HzConfig, "providers">, catalog: Catalog): boolean {
  if (model.trim() === "") return false;
  if (provider === "mock") return model === DEFAULT_MODELS.mock;
  const reg = config.providers?.providers.find((p) => p.id === provider);
  if (reg !== undefined) {
    const listed = reg.models ?? [];
    if (listed.length > 0) return listed.includes(model);
    // Keyless / empty models[] registry hosts may use any opaque id.
    if (reg.protocol === "openai-chat" && listed.length === 0) return true;
  }
  if (catalogModel(catalog, provider, model) !== undefined) return true;
  if (Object.prototype.hasOwnProperty.call(DEFAULT_MODELS, provider) && model === DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS]) {
    return true;
  }
  return false;
}

/** Case-insensitive substring filter (aider `--list-models <substr>`). */
export function filterModelIds(ids: readonly string[], substr: string | undefined): string[] {
  if (substr === undefined || substr.trim() === "") return [...ids];
  const needle = substr.trim().toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(needle));
}

/** Top-N closest ids by string similarity (for did-you-mean). */
export function suggestModelIds(query: string, candidates: readonly string[], limit = 5, minScore = 0.45): string[] {
  if (query.trim() === "" || candidates.length === 0) return [];
  const scored = candidates
    .map((id) => ({ id, score: similarity(query, id) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score || b.id.length - a.id.length || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((row) => row.id);
}

export function formatDidYouMean(query: string, suggestions: readonly string[]): string {
  if (suggestions.length === 0) return `unknown model: ${query}`;
  return `unknown model: ${query}\nDid you mean: ${suggestions.join(", ")}?`;
}

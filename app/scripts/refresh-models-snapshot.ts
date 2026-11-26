#!/usr/bin/env bun
/**
 * Human-run script: fetch models.dev v2 JSON, strip UNUSED_MODEL_FIELDS, enforce
 * MINIMUM_PROVIDERS = 100, and write a minified trimmed snapshot to
 * `app/src/core/catalog/models-dev.snapshot.json` (mirrors OpenCode's
 * `packages/core/script/models-snapshot.ts`).
 *
 * Not invoked by tests or gates.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_PATH,
  CATALOG_V1_PATH,
  DEFAULT_CATALOG_SOURCE,
  MINIMUM_PROVIDERS,
  countCatalogModels,
  decodeCatalog,
  resolveCatalogSource,
  validateCatalog,
} from "../src/core/catalog/catalog";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(root, "src/core/catalog/models-dev.snapshot.json");

/** Model fields HorizonCode / OpenCode never read (matches OpenCode `models-snapshot.ts`). */
export const UNUSED_MODEL_FIELDS = new Set([
  "description",
  "canonical_id",
  "knowledge",
  "last_updated",
  "deprecation_date",
  "open_weights",
  "metadata",
]);

const FALLBACK_URLS = [
  "https://models.dev/experimental/v2.0/api.json?type=chat",
  "https://models.dev/api.json",
];

export function buildCandidateUrls(env: Record<string, string | undefined> = process.env): string[] {
  const source = resolveCatalogSource(undefined, env).replace(/\/+$/, "");
  const defaultBase = DEFAULT_CATALOG_SOURCE.replace(/\/+$/, "");
  const isDirectJson = source.endsWith(".json") || source.includes("/api.json");
  const primary = isDirectJson ? source : `${source}${CATALOG_PATH}`;
  const urls = [primary];
  if (!isDirectJson) {
    urls.push(`${source}${CATALOG_V1_PATH}`);
  }
  if (source === defaultBase) {
    for (const fallback of FALLBACK_URLS) {
      if (!urls.includes(fallback)) urls.push(fallback);
    }
  }
  return urls;
}

export function trimModelsSnapshotJson(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev snapshot is not a JSON object");
  }
  const top = parsed as Record<string, unknown>;
  const trimmed = Object.fromEntries(
    Object.entries(top).map(([providerId, providerVal]) => {
      if (providerVal === null || typeof providerVal !== "object" || Array.isArray(providerVal)) {
        return [providerId, providerVal];
      }
      const provider = providerVal as Record<string, unknown>;
      const modelsRaw = provider.models;
      if (modelsRaw === null || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) {
        return [providerId, provider];
      }
      const trimmedModels = Object.fromEntries(
        Object.entries(modelsRaw as Record<string, unknown>).map(([modelId, modelVal]) => {
          if (modelVal === null || typeof modelVal !== "object" || Array.isArray(modelVal)) {
            return [modelId, modelVal];
          }
          return [
            modelId,
            Object.fromEntries(
              Object.entries(modelVal as Record<string, unknown>).filter(
                ([key]) => !UNUSED_MODEL_FIELDS.has(key),
              ),
            ),
          ];
        }),
      );
      return [providerId, { ...provider, models: trimmedModels }];
    }),
  );
  return JSON.stringify(trimmed);
}

export async function fetchValidatedCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; trimmed: string; decoded: ReturnType<typeof validateCatalog> }> {
  const urls = buildCandidateUrls(env);
  let lastError = "no URLs tried";
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        lastError = `${url} returned ${response.status} ${response.statusText}`;
        continue;
      }
      const text = await response.text();
      const trimmed = trimModelsSnapshotJson(text);
      const decoded = validateCatalog(decodeCatalog(JSON.parse(trimmed)), {
        minProviders: MINIMUM_PROVIDERS,
      });
      return { url, trimmed, decoded };
    } catch (err) {
      lastError = `${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`Failed to fetch models.dev snapshot (${DEFAULT_CATALOG_SOURCE}): ${lastError}`);
}

export function writeSnapshotAtomic(targetPath: string, content: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o644 });
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const { url, trimmed, decoded } = await fetchValidatedCatalog(process.env);
  const providers = Object.keys(decoded.providers).length;
  const models = countCatalogModels(decoded);
  process.stderr.write(`Fetched ${providers} providers, ${models} models from ${url}\n`);
  writeSnapshotAtomic(outFile, trimmed);
  process.stderr.write(`Wrote ${outFile} (${trimmed.length} bytes)\n`);
  process.stderr.write("Runtime loads this after HZ_MODELS_PATH / HZ_MODELS_SNAPSHOT / user cache.\n");
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(String(e instanceof Error ? e.message : e) + "\n");
    process.exit(1);
  });
}

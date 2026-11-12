#!/usr/bin/env bun
/**
 * Human-run script: fetch models.dev JSON and write a trimmed snapshot (docs/33 §5.7).
 * Not invoked by tests or gates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CATALOG_SOURCE,
  fetchLiveCatalog,
  countCatalogModels,
  MINIMUM_PROVIDERS,
} from "../src/core/catalog/catalog";
import { canonicalJson } from "../src/core/canon";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(root, "src/core/catalog/models-dev.snapshot.json");

async function main(): Promise<void> {
  const { catalog } = await fetchLiveCatalog(DEFAULT_CATALOG_SOURCE, { minProviders: MINIMUM_PROVIDERS });
  const providers = Object.keys(catalog.providers).length;
  const models = countCatalogModels(catalog);
  process.stderr.write(`Fetched ${providers} providers, ${models} models\n`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, canonicalJson(catalog) + "\n", { encoding: "utf8", mode: 0o644 });
  process.stderr.write(`Wrote ${outFile}\n`);
  process.stderr.write("Runtime loads this after env override (tests set HZ_NO_COMMITTED_SNAPSHOT=1).\n");
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + "\n");
  process.exit(1);
});

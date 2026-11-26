/**
 * Emit `app/schema/hzcode.schema.json` from CONFIG_KEYS (docs/33 §5.15),
 * preserving existing nested property schemas (`properties`, `items`,
 * `additionalProperties`, `required`, etc.) instead of clobbering them.
 * Run: `bun run app/scripts/gen-config-schema.ts`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_KEYS } from "../src/core/config";

const root = path.join(import.meta.dir, "..");
const outDir = path.join(root, "schema");
mkdirSync(outDir, { recursive: true });

const target = path.join(outDir, "hzcode.schema.json");
let existingProperties: Record<string, Record<string, unknown>> = {};
if (existsSync(target)) {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    if (parsed && typeof parsed.properties === "object" && parsed.properties !== null) {
      for (const [k, v] of Object.entries(parsed.properties)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          existingProperties[k] = v as Record<string, unknown>;
        }
      }
    }
  } catch {
    existingProperties = {};
  }
}

const properties: Record<string, unknown> = {};
for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
  const prev = existingProperties[key];
  const preserveNested = prev && prev.type === meta.type ? prev : undefined;
  const prop: Record<string, unknown> = {
    type: meta.type,
    description: meta.description,
  };
  if (meta.enum) {
    prop.enum = [...meta.enum];
  }
  if (preserveNested) {
    for (const [k, v] of Object.entries(preserveNested)) {
      if (k === "type" || k === "description" || k === "enum") continue;
      prop[k] = v;
    }
  }
  properties[key] = prop;
}

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "hzcode user config",
  type: "object",
  additionalProperties: false,
  properties,
};

writeFileSync(target, JSON.stringify(schema, null, 2) + "\n", "utf8");
process.stdout.write(`wrote ${target}\n`);

/**
 * Emit `app/schema/hzcode.schema.json` from CONFIG_KEYS (docs/33 §5.15).
 * Run: `bun run app/scripts/gen-config-schema.ts`
 */

import { writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_KEYS } from "../src/core/config";

const root = path.join(import.meta.dir, "..");
const outDir = path.join(root, "schema");
mkdirSync(outDir, { recursive: true });

const properties: Record<string, unknown> = {};
for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
  const prop: Record<string, unknown> = { type: meta.type, description: meta.description };
  if (meta.enum) prop.enum = [...meta.enum];
  properties[key] = prop;
}

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "hzcode user config",
  type: "object",
  additionalProperties: false,
  properties,
};

const target = path.join(outDir, "hzcode.schema.json");
writeFileSync(target, JSON.stringify(schema, null, 2) + "\n", "utf8");
process.stdout.write(`wrote ${target}\n`);

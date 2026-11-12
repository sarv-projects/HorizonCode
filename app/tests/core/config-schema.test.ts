import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_KEYS } from "../../src/core/config";

const schemaPath = path.join(import.meta.dir, "..", "..", "schema", "hzcode.schema.json");

describe("hzcode.schema.json", () => {
  test("matches CONFIG_KEYS", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
  });
});

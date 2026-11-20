import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checkConfigFile, CONFIG_KEYS } from "../../src/core/config";

const schemaPath = path.join(import.meta.dir, "..", "..", "schema", "hzcode.schema.json");

describe("hzcode.schema.json", () => {
  test("matches CONFIG_KEYS", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
  });

  test("documents class keys, effectHostKernel, sandboxChildNet, and lint", () => {
    for (const key of [
      "formatMessageClass",
      "providerClass",
      "modelClass",
      "effectHostKernel",
      "sandboxChildNet",
      "lint",
    ]) {
      expect(CONFIG_KEYS[key]).toBeDefined();
    }
    const dir = mkdtempSync(path.join(tmpdir(), "hz-schema-"));
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        provider: "mock",
        formatMessageClass: "anthropic",
        providerClass: "mock",
        modelClass: "openai",
        effectHostKernel: "require",
        sandboxChildNet: "off",
        lint: { commands: [{ extensions: ["*"], command: "echo {file}" }] },
      }),
    );
    const check = checkConfigFile(file);
    expect(check.unknown).toEqual([]);
    expect(check.rejected).toEqual([]);
  });

  test("snake_case class-key aliases are known to config check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-schema-snake-"));
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        provider: "mock",
        provider_class: "mock",
        model_class: "openai",
        format_message_class: "anthropic",
      }),
    );
    const check = checkConfigFile(file);
    expect(check.unknown).toEqual([]);
    expect(check.rejected).toEqual([]);
  });
});

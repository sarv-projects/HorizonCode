import { describe, expect, test } from "bun:test";
import { BUILTIN_COMMANDS } from "../../src/core/commands";
import {
  BUILTIN_SLASH_REGISTRY,
  builtinSlashCommandNames,
  builtinSlashHelpRows,
} from "../../src/core/slash-registry";

describe("slash-registry", () => {
  test("BUILTIN_COMMANDS is derived from the registry", () => {
    expect([...BUILTIN_COMMANDS].sort((a, b) => a.localeCompare(b))).toEqual([...builtinSlashCommandNames()]);
  });

  test("/help rows cover built-in command names", () => {
    const names = new Set(BUILTIN_SLASH_REGISTRY.flatMap((r) => [r.name, ...(r.aliases ?? [])]));
    for (const cmd of BUILTIN_COMMANDS) {
      expect(names.has(cmd)).toBe(true);
    }
  });

  test("models is documented for provider listing", () => {
    expect(BUILTIN_SLASH_REGISTRY.some((r) => r.name === "models")).toBe(true);
    expect(builtinSlashHelpRows().some(([u]) => u === "/models")).toBe(true);
  });
});

/**
 * H-3 / ruling 484: config class-name keys (short name or documented import path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CONFIG_CLASS_KEYS,
  ConfigClassResolveError,
  FORMATTER_CLASS_ALIASES,
  MODEL_CLASS_ALIASES,
  PROVIDER_CLASS_ALIASES,
  listConfigClassShortNames,
  normalizeConfigClassImportPath,
  normalizeConfigClassKey,
  parseConfigClassFields,
  resolveConfigClassKey,
} from "../../src/core/config-class-keys";
import { defaultConfigPath, loadConfig } from "../../src/core/config";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "hz-class-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("normalizeConfigClassKey", () => {
  test("accepts camel and snake", () => {
    expect(normalizeConfigClassKey("providerClass")).toBe("providerClass");
    expect(normalizeConfigClassKey("provider_class")).toBe("providerClass");
    expect(normalizeConfigClassKey("modelClass")).toBe("modelClass");
    expect(normalizeConfigClassKey("model_class")).toBe("modelClass");
    expect(normalizeConfigClassKey("formatMessageClass")).toBe("formatMessageClass");
    expect(normalizeConfigClassKey("format_message_class")).toBe("formatMessageClass");
    expect(normalizeConfigClassKey("other")).toBeUndefined();
  });
});

describe("resolveConfigClassKey (short name)", () => {
  test("providerClass short names map to documented modules", () => {
    for (const [short, modulePath] of Object.entries(PROVIDER_CLASS_ALIASES)) {
      const got = resolveConfigClassKey("providerClass", short);
      expect(got).toEqual({
        key: "providerClass",
        spec: short,
        modulePath,
        via: "short-name",
      });
    }
  });

  test("modelClass short names map to documented modules", () => {
    for (const [short, modulePath] of Object.entries(MODEL_CLASS_ALIASES)) {
      const got = resolveConfigClassKey("modelClass", short);
      expect(got.modulePath).toBe(modulePath);
      expect(got.via).toBe("short-name");
    }
  });
});

describe("resolveConfigClassKey (import path)", () => {
  test("accepts slash and dotted documented paths", () => {
    const slash = resolveConfigClassKey("providerClass", "core/providers/openai");
    expect(slash.via).toBe("import-path");
    expect(slash.modulePath).toBe("core/providers/openai");

    const dotted = resolveConfigClassKey("providerClass", "core.providers.anthropic");
    expect(dotted.via).toBe("import-path");
    expect(dotted.modulePath).toBe("core/providers/anthropic");

    const withPrefix = resolveConfigClassKey("modelClass", "app/src/core/providers/mock");
    expect(withPrefix.modulePath).toBe("core/providers/mock");
    expect(withPrefix.via).toBe("import-path");
  });

  test("refuses arbitrary paths (no plugin load)", () => {
    expect(() => resolveConfigClassKey("providerClass", "evil/remote/plugin")).toThrow(
      ConfigClassResolveError,
    );
    try {
      resolveConfigClassKey("providerClass", "evil/remote/plugin");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigClassResolveError);
      const e = err as ConfigClassResolveError;
      expect(e.message).toContain("openai");
      expect(e.message).toContain("no plugin registry");
      expect(e.knownShortNames).toEqual(listConfigClassShortNames("providerClass"));
    }
  });

  test("empty spec fails", () => {
    expect(() => resolveConfigClassKey("modelClass", "  ")).toThrow(ConfigClassResolveError);
  });
});

describe("normalizeConfigClassImportPath", () => {
  test("strips app/src and converts dots", () => {
    expect(normalizeConfigClassImportPath("./core.providers.openai")).toBe("core/providers/openai");
    expect(normalizeConfigClassImportPath("app/src/core/providers/google")).toBe(
      "core/providers/google",
    );
  });
});

describe("parseConfigClassFields", () => {
  test("resolves camel and snake; rejects unknown without throwing", () => {
    const ok = parseConfigClassFields({
      provider_class: "openai",
      modelClass: "core/providers/anthropic",
    });
    expect(ok.providerClass?.modulePath).toBe("core/providers/openai");
    expect(ok.modelClass?.via).toBe("import-path");
    expect(ok.providerClassRejected).toBeUndefined();

    const bad = parseConfigClassFields({ providerClass: "not-a-provider" });
    expect(bad.providerClass).toBeUndefined();
    expect(bad.providerClassRejected).toContain("Unknown providerClass");
  });
});

describe("loadConfig class-name keys (H-3 reduced)", () => {
  test("loads providerClass short name from user config", () => {
    const userFile = defaultConfigPath(home);
    mkdirSync(path.dirname(userFile), { recursive: true });
    writeFileSync(
      userFile,
      JSON.stringify({ provider: "mock", providerClass: "mock", model_class: "openai" }),
      "utf8",
    );
    const cfg = loadConfig({ HOME: home, USERPROFILE: home, HZ_PROVIDER: "mock" }, userFile);
    expect(cfg.providerClass?.modulePath).toBe("core/providers/mock");
    expect(cfg.providerClass?.via).toBe("short-name");
    expect(cfg.modelClass?.modulePath).toBe("core/providers/openai");
    expect(cfg.providerClassRejected).toBeUndefined();
    expect(cfg.modelClassRejected).toBeUndefined();
  });

  test("unknown providerClass is named rejection, not a startup throw", () => {
    const userFile = defaultConfigPath(home);
    mkdirSync(path.dirname(userFile), { recursive: true });
    writeFileSync(userFile, JSON.stringify({ providerClass: "totally-fake" }), "utf8");
    const cfg = loadConfig({ HOME: home, USERPROFILE: home, HZ_PROVIDER: "mock" }, userFile);
    expect(cfg.providerClass).toBeUndefined();
    expect(cfg.providerClassRejected).toContain("totally-fake");
  });
});

describe("H-4 additive formatMessageClass key (ruling 494)", () => {
  test("is part of the closed class-key set", () => {
    expect(CONFIG_CLASS_KEYS).toContain("formatMessageClass");
    expect(listConfigClassShortNames("formatMessageClass")).toEqual(
      Object.keys(FORMATTER_CLASS_ALIASES).sort(),
    );
  });

  test("short names resolve to stable built-in dialect ids", () => {
    for (const [short, dialect] of Object.entries(FORMATTER_CLASS_ALIASES)) {
      const got = resolveConfigClassKey("formatMessageClass", short);
      expect(got).toEqual({ key: "formatMessageClass", spec: short, modulePath: dialect, via: "short-name" });
    }
    // OpenAI-compatible dialects reuse the OpenAI formatter.
    expect(FORMATTER_CLASS_ALIASES["openai-compatible"]).toBe("openai");
    expect(FORMATTER_CLASS_ALIASES.mock).toBe("openai");
  });

  test("unknown formatter spec fails with a readable, closed-map error", () => {
    expect(() => resolveConfigClassKey("formatMessageClass", "remote/plugin")).toThrow(ConfigClassResolveError);
    try {
      resolveConfigClassKey("formatMessageClass", "remote/plugin");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigClassResolveError);
      expect((err as ConfigClassResolveError).knownShortNames).toEqual(
        listConfigClassShortNames("formatMessageClass"),
      );
    }
  });

  test("parseConfigClassFields surfaces resolved formatter + named rejection", () => {
    const ok = parseConfigClassFields({ format_message_class: "anthropic", providerClass: "openai" });
    expect(ok.formatMessageClass?.modulePath).toBe("anthropic");
    expect(ok.formatMessageClass?.via).toBe("short-name");
    expect(ok.formatMessageClassRejected).toBeUndefined();
    expect(ok.providerClass?.modulePath).toBe("core/providers/openai");

    const bad = parseConfigClassFields({ formatMessageClass: "nope" });
    expect(bad.formatMessageClass).toBeUndefined();
    expect(bad.formatMessageClassRejected).toContain("Unknown formatMessageClass");
  });
});

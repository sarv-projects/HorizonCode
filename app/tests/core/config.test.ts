/**
 * config.test.ts — settings precedence: environment > ~/.hzcode/config.json > defaults.
 *
 * `loadConfig` takes the env and the config path explicitly, which is exactly how
 * production calls it; the tests write a config file into a temp HOME, install
 * that HOME in process.env (saved and restored) and never read the real one.
 * Note: Bun resolves os.homedir() once at start-up, so a temp HOME is passed in
 * as defaultConfigPath(home) rather than relied on through the implicit default.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DEFAULT_MODELS, defaultConfigPath, describeConfig, loadConfig, missingKey, readConfigFile } from "../../src/core/config";
import { cleanupTemps, restoreEnv, setEnv, snapshotEnv, tempDir, type EnvSnapshot } from "./helpers";

let envBackup: EnvSnapshot;

/** A temp HOME, optionally holding a ~/.hzcode/config.json. */
function homeWithConfig(contents?: string): { home: string; file: string } {
  const home = tempDir("hz-home-");
  const file = defaultConfigPath(home);
  if (contents !== undefined) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return { home, file };
}

/** Nothing about the ambient environment may leak into a config assertion. */
function cleanEnv(): void {
  setEnv({
    HZ_PROVIDER: undefined,
    HZ_MODEL: undefined,
    HZ_BASE_URL: undefined,
    HZ_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  });
}

beforeAll(() => {
  envBackup = snapshotEnv();
});

afterAll(() => {
  restoreEnv(envBackup);
  cleanupTemps();
});

test("zero configuration answers with the offline mock provider", () => {
  cleanEnv();
  const { file } = homeWithConfig();
  const config = loadConfig({}, file);

  expect(config.provider).toBe("mock");
  expect(config.model).toBe(DEFAULT_MODELS.mock);
  expect(config.model).toBe("mock-1");
  expect(config.baseUrl).toBeUndefined();
  expect(config.apiKey).toBeUndefined();
  expect(config.sources).toEqual({ provider: "default", model: "default", baseUrl: "default", apiKey: "none" });
  expect(missingKey(config)).toBeNull();
  expect(describeConfig(config)).toBe("mock \u00b7 mock-1");
  expect(readConfigFile(file)).toEqual({});
  // Blank environment values are the same as absent ones.
  expect(loadConfig({ HZ_PROVIDER: "", HZ_MODEL: "   " }, file).sources.provider).toBe("default");
});

test("~/.hzcode/config.json supplies provider and model", () => {
  cleanEnv();
  const { file } = homeWithConfig(JSON.stringify({ provider: "anthropic", model: "claude-test" }));
  const config = loadConfig({}, file);

  expect(config.provider).toBe("anthropic");
  expect(config.model).toBe("claude-test");
  expect(config.baseUrl).toBe("https://api.anthropic.com");
  expect(config.sources).toEqual({ provider: "file", model: "file", baseUrl: "default", apiKey: "none" });
  expect(config.apiKey).toBeUndefined();
  expect(missingKey(config)).toBe("ANTHROPIC_API_KEY");
});

test("HZ_PROVIDER and HZ_MODEL override the config file", () => {
  cleanEnv();
  const { file } = homeWithConfig(
    JSON.stringify({ provider: "anthropic", model: "claude-test", baseUrl: "https://file.example" }),
  );
  const config = loadConfig({ HZ_PROVIDER: "openai", HZ_MODEL: "gpt-test" }, file);

  expect(config.provider).toBe("openai");
  expect(config.model).toBe("gpt-test");
  expect(config.sources.provider).toBe("env");
  expect(config.sources.model).toBe("env");
  // No HZ_BASE_URL: the file's endpoint is still the one in force.
  expect(config.baseUrl).toBe("https://file.example");
  expect(config.sources.baseUrl).toBe("file");

  // With no baseUrl anywhere the provider default applies.
  const defaults = homeWithConfig(JSON.stringify({ provider: "openai" }));
  expect(loadConfig({}, defaults.file).baseUrl).toBe("https://api.openai.com");
  expect(loadConfig({ HZ_BASE_URL: "https://env.example" }, defaults.file).baseUrl).toBe("https://env.example");
  expect(loadConfig({ HZ_BASE_URL: "https://env.example" }, defaults.file).sources.baseUrl).toBe("env");
});

test("API keys: HZ_API_KEY beats the file, the file beats nothing", () => {
  cleanEnv();
  const { file } = homeWithConfig(JSON.stringify({ provider: "openai", apiKey: "file-key" }));

  const fromFile = loadConfig({}, file);
  expect(fromFile.apiKey).toBe("file-key");
  expect(fromFile.sources.apiKey).toBe("file");
  expect(missingKey(fromFile)).toBeNull();

  const fromEnv = loadConfig({ HZ_API_KEY: "env-key" }, file);
  expect(fromEnv.apiKey).toBe("env-key");
  expect(fromEnv.sources.apiKey).toBe("env");
});

test("a provider key in the environment is a detection, never an override", () => {
  cleanEnv();
  const { file } = homeWithConfig();

  const detected = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-detected" }, file);
  expect(detected.provider).toBe("anthropic");
  expect(detected.sources.provider).toBe("detected");
  expect(detected.model).toBe(DEFAULT_MODELS.anthropic);
  expect(detected.apiKey).toBe("sk-ant-detected");
  expect(detected.sources.apiKey).toBe("env");
  expect(missingKey(detected)).toBeNull();

  expect(loadConfig({ OPENAI_API_KEY: "sk-openai" }, file).provider).toBe("openai");
  // An explicit provider always wins over a detected key.
  expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant", HZ_PROVIDER: "mock" }, file).provider).toBe("mock");

  // The file wins over detection, and the other provider's key does not leak in.
  const withFile = homeWithConfig(JSON.stringify({ provider: "openai" }));
  const config = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-detected" }, withFile.file);
  expect(config.provider).toBe("openai");
  expect(config.sources.provider).toBe("file");
  expect(config.apiKey).toBeUndefined();
  expect(config.sources.apiKey).toBe("none");
  expect(missingKey(config)).toBe("OPENAI_API_KEY");
});

test("a malformed or wrong-shaped config file is treated as absent", () => {
  cleanEnv();
  const broken = homeWithConfig("{ not json at all");
  expect(readConfigFile(broken.file)).toEqual({});
  expect(loadConfig({}, broken.file).provider).toBe("mock");

  const list = homeWithConfig("[1, 2, 3]");
  expect(readConfigFile(list.file)).toEqual({});
  expect(loadConfig({}, list.file).provider).toBe("mock");

  const nonsense = homeWithConfig(JSON.stringify({ provider: "bogus", model: "   " }));
  expect(loadConfig({}, nonsense.file).provider).toBe("mock");
  expect(loadConfig({}, nonsense.file).model).toBe(DEFAULT_MODELS.mock);

  const trimmed = homeWithConfig(JSON.stringify({ provider: "MOCK", model: " custom ", apiKey: "  spaced  " }));
  const config = loadConfig({}, trimmed.file);
  expect(config.provider).toBe("mock");
  expect(config.model).toBe("custom");
  expect(config.apiKey).toBe("spaced");

  // A directory where the file should be is not a crash either.
  expect(readConfigFile(tempDir("hz-home-dir-"))).toEqual({});
});

test("the config path follows HOME (temp HOME installed, real one restored)", () => {
  cleanEnv();
  expect(defaultConfigPath()).toBe(path.join(homedir(), ".hzcode", "config.json"));

  const home = tempDir("hz-home-env-");
  const file = path.join(home, ".hzcode", "config.json");
  expect(defaultConfigPath(home)).toBe(file);

  setEnv({ HOME: home });
  expect(process.env.HOME).toBe(home);
  expect(defaultConfigPath(process.env.HOME)).toBe(file);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ provider: "openai", model: "gpt-from-home" }));
  const config = loadConfig(process.env, defaultConfigPath(process.env.HOME));
  expect(config.provider).toBe("openai");
  expect(config.model).toBe("gpt-from-home");
  expect(config.sources.provider).toBe("file");
});

test("HZ_MAX_* budget variables parse; 0 means unlimited and junk is ignored", () => {
  const { file } = homeWithConfig();
  expect(loadConfig({}, file).budget).toBeUndefined();

  const parsed = loadConfig({ HZ_MAX_STEPS: "7", HZ_MAX_TOKENS: "1200", HZ_MAX_WALL_MS: "30000" }, file);
  expect(parsed.budget).toEqual({ maxSteps: 7, maxTokens: 1200, maxWallMs: 30000 });

  // 0 is not "no budget written", it is the explicit unlimited ceiling.
  expect(loadConfig({ HZ_MAX_STEPS: "0" }, file).budget).toEqual({ maxSteps: 0 });

  // Nonsense and negatives are ignored, never widened or crashed on.
  expect(loadConfig({ HZ_MAX_STEPS: "nonsense" }, file).budget).toBeUndefined();
  expect(loadConfig({ HZ_MAX_STEPS: "-3" }, file).budget).toBeUndefined();
});

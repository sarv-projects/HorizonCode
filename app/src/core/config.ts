/**
 * config.ts — the runtime's settings, resolved once at startup.
 *
 * Precedence: environment > ~/.hzcode/config.json > defaults.
 *
 * The default provider is `mock`, so `hzcode` starts a working chat with no
 * configuration at all. A provider-specific key in the environment
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY) is treated as configuration of that
 * provider, but it never overrides an explicitly chosen one.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type ProviderName = "anthropic" | "openai" | "mock";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "mock"];

/** Model used when nothing else is configured, per provider. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  mock: "mock-1",
};

/** Endpoint root used when nothing else is configured. `mock` has no endpoint. */
export const DEFAULT_BASE_URLS: Record<Exclude<ProviderName, "mock">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

export interface HzConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Where the values came from, for the banner and for debugging. */
  sources: {
    provider: "env" | "file" | "detected" | "default";
    model: "env" | "file" | "default";
    baseUrl: "env" | "file" | "default";
    apiKey: "env" | "file" | "none";
  };
}

export type EnvLike = Record<string, string | undefined>;

interface ConfigFile {
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}

/** `~/.hzcode/config.json` — the one file a human may edit by hand. */
export function defaultConfigPath(home: string = homedir()): string {
  return path.join(home, ".hzcode", "config.json");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeProvider(value: string | undefined): ProviderName | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return lower === "anthropic" || lower === "openai" || lower === "mock" ? lower : undefined;
}

/**
 * Read the config file. Anything unreadable, malformed or of the wrong shape is
 * treated as absent: a broken config file must never stop the chat from starting.
 */
export function readConfigFile(file: string = defaultConfigPath()): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConfigFile;
    }
    return {};
  } catch {
    return {};
  }
}

/** A provider key sitting in the environment is a hint, not an order. */
function detectProvider(env: EnvLike): ProviderName | undefined {
  if (str(env.ANTHROPIC_API_KEY)) return "anthropic";
  if (str(env.OPENAI_API_KEY)) return "openai";
  return undefined;
}

function providerKey(provider: ProviderName, env: EnvLike): string | undefined {
  if (provider === "anthropic") return str(env.ANTHROPIC_API_KEY);
  if (provider === "openai") return str(env.OPENAI_API_KEY);
  return undefined;
}

/** Resolve the effective configuration (pure; the environment is injectable). */
export function loadConfig(env: EnvLike = process.env, file: string = defaultConfigPath()): HzConfig {
  const fromFile = readConfigFile(file);

  const envProvider = normalizeProvider(str(env.HZ_PROVIDER));
  const fileProvider = normalizeProvider(str(fromFile.provider));
  const detected = detectProvider(env);
  const provider: ProviderName = envProvider ?? fileProvider ?? detected ?? "mock";
  const providerSource: HzConfig["sources"]["provider"] = envProvider
    ? "env"
    : fileProvider
      ? "file"
      : detected
        ? "detected"
        : "default";

  const envModel = str(env.HZ_MODEL);
  const fileModel = str(fromFile.model);
  const model = envModel ?? fileModel ?? DEFAULT_MODELS[provider];

  const envBase = str(env.HZ_BASE_URL);
  const fileBase = str(fromFile.baseUrl);
  const defaultBase = provider === "mock" ? undefined : DEFAULT_BASE_URLS[provider];
  const baseUrl = envBase ?? fileBase ?? defaultBase;

  const envKey = str(env.HZ_API_KEY);
  const fileKey = str(fromFile.apiKey);
  const detectedKey = providerKey(provider, env);
  const apiKey = envKey ?? fileKey ?? detectedKey;

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    sources: {
      provider: providerSource,
      model: envModel ? "env" : fileModel ? "file" : "default",
      baseUrl: envBase ? "env" : fileBase ? "file" : "default",
      apiKey: envKey ? "env" : fileKey ? "file" : detectedKey ? "env" : "none",
    },
  };
}

/** One short line for the UI: `mock · mock-1` or `anthropic · claude-sonnet-4-5`. */
export function describeConfig(config: HzConfig): string {
  return `${config.provider} \u00b7 ${config.model}`;
}

/** True when the provider needs a key and does not have one yet. */
export function missingKey(config: HzConfig): string | null {
  if (config.provider === "mock") return null;
  if (config.apiKey) return null;
  return config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

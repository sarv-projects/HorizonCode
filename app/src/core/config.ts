/**
 * config.ts — the runtime's settings, resolved once at startup.
 *
 * Precedence: environment > the user config file (`~/.config/horizon/config.json`
 * canonical, or `~/.hzcode/config.json` when that tree exists — honoured in
 * place, see paths.ts) > defaults.
 *
 * The default provider is `mock`, so `hzcode` starts a working chat with no
 * configuration at all. A provider-specific key in the environment
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY) is
 * treated as configuration of that provider, but it never overrides an
 * explicitly chosen one. Ollama needs no key at all: it is a local server.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { RunBudget } from "../contracts";
import { userConfigDir } from "./paths";

export type ProviderName = "anthropic" | "openai" | "google" | "ollama" | "mock";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "google", "ollama", "mock"];

/** Model used when nothing else is configured, per provider. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  ollama: "llama3.1",
  mock: "mock-1",
};

/** Endpoint root used when nothing else is configured. `mock` has no endpoint. */
export const DEFAULT_BASE_URLS: Record<Exclude<ProviderName, "mock">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};

export interface HzConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** NF-073 run budgets from the environment; absent keys stay unlimited. */
  budget?: RunBudget;
  /**
   * MCP servers, v1 reduced form (docs/09 §4.7). ONLY entries from the USER
   * config file are eligible: a workspace cannot name a server that would run
   * with the user's authority (README §3.4 "programs named by a workspace stay
   * off until trusted" — v1 has no trust store, so it has no workspace path at
   * all). Entries that do not parse are skipped and named in `rejected`; a
   * malformed entry must never stop the chat from starting.
   */
  mcp?: McpConfig;
  /**
   * Language servers, default OFF (docs/09 §4.7). As with MCP, only entries
   * from the USER config file are eligible: a language server runs with the
   * user's authority, so a workspace cannot name one. With no `lsp` section the
   * value is undefined and nothing is started. Entries that do not parse are
   * skipped and named in `rejected`; a malformed entry never stops the chat
   * from starting. The server list is pure config DATA — no command is baked in.
   */
  lsp?: LspConfig;
  /** Where the values came from, for the banner and for debugging. */
  sources: {
    provider: "env" | "file" | "detected" | "default";
    model: "env" | "file" | "default";
    baseUrl: "env" | "file" | "default";
    apiKey: "env" | "file" | "none";
  };
}

/** One configured MCP server (stdio only in v1). */
export interface McpServerConfig {
  /** The slug that namespaces this server's tools: `[a-z0-9-]+`. */
  id: string;
  /** The program to start (spawned through the one owned-spawn path). */
  command: string;
  args?: string[];
  /** Extra environment entries for the child; hzcode's env is scrubbed first. */
  env?: Record<string, string>;
  cwd?: string;
}

/** The parsed `mcp` config section: what to start, and what was skipped. */
export interface McpConfig {
  servers: McpServerConfig[];
  /** One readable line per entry that was malformed and skipped. */
  rejected: string[];
}

/** One configured language server (stdio only). */
export interface LspServerConfig {
  /** The slug that names this server: `[a-z0-9-]+`. */
  id: string;
  /** The program to start (spawned through the one owned-spawn path). */
  command: string;
  args?: string[];
  /** Extra environment entries for the child; hzcode's env is scrubbed first. */
  env?: Record<string, string>;
  /**
   * File extensions this server handles, WITHOUT the leading dot and
   * lowercased (e.g. `["ts", "tsx"]`). Non-empty.
   */
  extensions: string[];
  /** Files/dirs that mark the project root (e.g. `["tsconfig.json"]`). */
  rootMarkers?: string[];
}

/** The parsed `lsp` config section: what to start, and what was skipped. */
export interface LspConfig {
  servers: LspServerConfig[];
  /** One readable line per entry that was malformed and skipped. */
  rejected: string[];
}

export type EnvLike = Record<string, string | undefined>;

interface ConfigFile {
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  mcp?: unknown;
  lsp?: unknown;
}

/** `~/.config/horizon/config.json`, or `~/.hzcode/config.json` in place (paths.ts). */
export function defaultConfigPath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "config.json");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Environment budget fields: a non-negative number, else absent. 0 = unlimited. */
function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function normalizeProvider(value: string | undefined): ProviderName | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return lower === "anthropic" || lower === "openai" || lower === "google" || lower === "ollama" || lower === "mock"
    ? lower
    : undefined;
}

/** The slug an MCP server id must match so the tool-name grammar round-trips. */
const MCP_SERVER_ID = /^[a-z0-9-]+$/;

/**
 * Validate one `mcp.servers[]` entry. Returns the normalized server, or a
 * readable reason string — never throws: a malformed entry is a skip that gets
 * named (the manager emits it as a notice), not a startup failure.
 */
export function parseMcpServer(value: unknown, index: number): McpServerConfig | string {
  const where = `mcp.servers[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} is not an object`;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "" || !MCP_SERVER_ID.test(id)) {
    return `${where}.id must match [a-z0-9-] (got ${JSON.stringify(raw.id ?? null)})`;
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (command === "") return `${where}.command must be a non-empty string`;
  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      return `${where}.args must be an array of strings`;
    }
    args = raw.args as string[];
  }
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      return `${where}.env must be an object of strings`;
    }
    for (const [key, item] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof item !== "string") return `${where}.env.${key} must be a string`;
    }
    env = { ...(raw.env as Record<string, string>) };
  }
  let cwd: string | undefined;
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") return `${where}.cwd must be a non-empty string`;
    cwd = raw.cwd;
  }
  const server: McpServerConfig = { id, command };
  if (args !== undefined) server.args = args;
  if (env !== undefined) server.env = env;
  if (cwd !== undefined) server.cwd = cwd;
  return server;
}

/**
 * Parse the `mcp` section of the config file. `undefined` means "no mcp
 * section" (or nothing usable in it); rejected entries are collected, never
 * thrown — the manager turns them into notices.
 */
export function parseMcpConfig(value: unknown): McpConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return { servers: [], rejected: ["mcp must be an object with an optional `servers` array"] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.servers === undefined) return undefined;
  if (!Array.isArray(raw.servers)) return { servers: [], rejected: ["mcp.servers must be an array"] };
  const servers: McpServerConfig[] = [];
  const rejected: string[] = [];
  const ids = new Set<string>();
  (raw.servers as unknown[]).forEach((item, index) => {
    const parsed = parseMcpServer(item, index);
    if (typeof parsed === "string") {
      rejected.push(parsed);
      return;
    }
    if (ids.has(parsed.id)) {
      rejected.push(`mcp.servers[${index}] duplicates server id ${JSON.stringify(parsed.id)}; skipped`);
      return;
    }
    ids.add(parsed.id);
    servers.push(parsed);
  });
  if (servers.length === 0 && rejected.length === 0) return undefined;
  return { servers, rejected };
}

/** The slug a language server id must match, matching the MCP grammar. */
const LSP_SERVER_ID = /^[a-z0-9-]+$/;

/**
 * Validate one `lsp.servers[]` entry. Returns the normalized server, or a
 * readable reason string — never throws: a malformed entry is a skip that gets
 * named, not a startup failure. Mirrors parseMcpServer.
 */
export function parseLspServer(value: unknown, index: number): LspServerConfig | string {
  const where = `lsp.servers[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} is not an object`;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "" || !LSP_SERVER_ID.test(id)) {
    return `${where}.id must match [a-z0-9-] (got ${JSON.stringify(raw.id ?? null)})`;
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (command === "") return `${where}.command must be a non-empty string`;
  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      return `${where}.args must be an array of strings`;
    }
    args = raw.args as string[];
  }
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      return `${where}.env must be an object of strings`;
    }
    for (const [key, item] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof item !== "string") return `${where}.env.${key} must be a string`;
    }
    env = { ...(raw.env as Record<string, string>) };
  }
  if (!Array.isArray(raw.extensions) || raw.extensions.length === 0) {
    return `${where}.extensions must be a non-empty array of strings`;
  }
  const extensions: string[] = [];
  for (const ext of raw.extensions as unknown[]) {
    if (typeof ext !== "string" || ext.trim() === "") {
      return `${where}.extensions must be a non-empty array of strings`;
    }
    // Normalize: dotless, lowercased, so matching is by the bare extension.
    extensions.push(ext.trim().replace(/^\.+/, "").toLowerCase());
  }
  let rootMarkers: string[] | undefined;
  if (raw.rootMarkers !== undefined) {
    if (!Array.isArray(raw.rootMarkers) || raw.rootMarkers.some((m) => typeof m !== "string")) {
      return `${where}.rootMarkers must be an array of strings`;
    }
    rootMarkers = raw.rootMarkers as string[];
  }
  const server: LspServerConfig = { id, command, extensions };
  if (args !== undefined) server.args = args;
  if (env !== undefined) server.env = env;
  if (rootMarkers !== undefined) server.rootMarkers = rootMarkers;
  return server;
}

/**
 * Parse the `lsp` section of the config file. `undefined` means "no lsp
 * section" (or nothing usable in it); rejected entries are collected, never
 * thrown. Default OFF: absent section -> undefined. Mirrors parseMcpConfig.
 */
export function parseLspConfig(value: unknown): LspConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return { servers: [], rejected: ["lsp must be an object with an optional `servers` array"] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.servers === undefined) return undefined;
  if (!Array.isArray(raw.servers)) return { servers: [], rejected: ["lsp.servers must be an array"] };
  const servers: LspServerConfig[] = [];
  const rejected: string[] = [];
  const ids = new Set<string>();
  (raw.servers as unknown[]).forEach((item, index) => {
    const parsed = parseLspServer(item, index);
    if (typeof parsed === "string") {
      rejected.push(parsed);
      return;
    }
    if (ids.has(parsed.id)) {
      rejected.push(`lsp.servers[${index}] duplicates server id ${JSON.stringify(parsed.id)}; skipped`);
      return;
    }
    ids.add(parsed.id);
    servers.push(parsed);
  });
  if (servers.length === 0 && rejected.length === 0) return undefined;
  return { servers, rejected };
}

/**
 * The configured language servers that handle a file, selected by its dotless,
 * lowercased extension. Pure: returns `[]` for an undefined config or an
 * unconfigured extension.
 */
export function lspServersForFile(config: LspConfig | undefined, absPath: string): LspServerConfig[] {
  if (config === undefined) return [];
  const dot = absPath.lastIndexOf(".");
  const slash = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  if (dot <= slash + 1) return []; // no extension, or a dotfile with no extension
  const ext = absPath.slice(dot + 1).toLowerCase();
  if (ext === "") return [];
  return config.servers.filter((server) => server.extensions.includes(ext));
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
  if (str(env.GEMINI_API_KEY) || str(env.GOOGLE_API_KEY)) return "google";
  return undefined;
}

function providerKey(provider: ProviderName, env: EnvLike): string | undefined {
  if (provider === "anthropic") return str(env.ANTHROPIC_API_KEY);
  if (provider === "openai") return str(env.OPENAI_API_KEY);
  if (provider === "google") return str(env.GEMINI_API_KEY) ?? str(env.GOOGLE_API_KEY);
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

  // NF-073: HZ_MAX_STEPS / HZ_MAX_TOKENS / HZ_MAX_WALL_MS, 0 = unlimited.
  const budget: RunBudget = {};
  const envSteps = envNumber(str(env.HZ_MAX_STEPS));
  const envTokens = envNumber(str(env.HZ_MAX_TOKENS));
  const envWall = envNumber(str(env.HZ_MAX_WALL_MS));
  if (envSteps !== undefined) budget.maxSteps = envSteps;
  if (envTokens !== undefined) budget.maxTokens = envTokens;
  if (envWall !== undefined) budget.maxWallMs = envWall;

  const mcp = parseMcpConfig(fromFile.mcp);
  const lsp = parseLspConfig(fromFile.lsp);

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    budget: Object.keys(budget).length > 0 ? budget : undefined,
    mcp,
    lsp,
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
  if (config.provider === "mock" || config.provider === "ollama") return null;
  if (config.apiKey) return null;
  return config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : config.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
}

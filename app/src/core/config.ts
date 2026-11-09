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
import type { Credential, RunBudget } from "../contracts";
import { catalogDefaultModel, loadCatalog, type LoadedCatalog } from "./catalog/catalog";
import { userConfigDir } from "./paths";

export type ProviderName = "anthropic" | "openai" | "google" | "ollama" | "mock";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "google", "ollama", "mock"];

/**
 * Model used when nothing else is configured, per provider.
 *
 * FEAT-003 (spec §5.4): the default model for a built-in provider now resolves
 * through the model catalog (`catalog/catalog.ts`) — `catalogDefaultModel`. This
 * map is kept as the OFFLINE FALLBACK, used only when the catalog lacks the
 * provider. The curated catalog snapshot carries these exact ids, so a resolved
 * default equals the fallback here; the values MUST stay byte-identical (the
 * config/providers-expansion tests assert `config.model === DEFAULT_MODELS.<p>`
 * and the literal strings). Capabilities/limits are DATA read from the catalog,
 * never inferred from the id.
 */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  ollama: "llama3.1",
  mock: "mock-1",
};

/**
 * The default model for a BUILT-IN provider: the catalog's default when it knows
 * the provider, else the historical hardcoded fallback. Pure; the catalog is
 * injectable so tests can pin it without touching the environment.
 */
export function builtinDefaultModel(provider: ProviderName, catalog: LoadedCatalog = loadCatalog()): string {
  return catalogDefaultModel(catalog, provider) ?? DEFAULT_MODELS[provider];
}

/** Endpoint root used when nothing else is configured. `mock` has no endpoint. */
export const DEFAULT_BASE_URLS: Record<Exclude<ProviderName, "mock">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};

export interface HzConfig {
  /**
   * The selected provider id. A built-in `ProviderName`, or a registered id
   * (any slug) when `providers` names one — the `string` arm keeps the field
   * open for registry ids without losing autocomplete on the built-ins.
   */
  provider: ProviderName | (string & {});
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
   * User-declared providers, v1 reduced form (docs/15 §3.1). Like `mcp`, ONLY
   * entries from the USER config file are eligible, and a malformed entry is a
   * named skip (collected in `providers.rejected`), never a startup failure.
   */
  providers?: ProviderRegistry;
  /**
   * The registered provider the configuration selected, resolved against the
   * environment. Present only when `provider` names a registry entry; built-ins
   * leave it undefined and are handled by `makeProvider`'s switch.
   */
  resolved?: ResolvedProvider;
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

/**
 * The wire protocol a registered provider speaks. v1 ships one — `openai-chat`,
 * the OpenAI /v1/chat/completions shape served by DeepSeek / Groq / Together /
 * OpenRouter / xAI / vLLM / NVIDIA-NIM / etc. The field exists so later
 * additive codecs (anthropic-compatible, responses-compatible) extend the
 * registry rather than changing its shape; an unknown value is rejected with a
 * readable reason, never silently coerced.
 */
export type ProviderProtocol = "openai-chat";

/**
 * One user-declared provider (docs/15 §3.1 ProviderContributionV1: "endpoint +
 * codec id, never code"). It names a host that speaks a known protocol; the
 * adapter is data, not code. USER-config only, mirroring the MCP authority rule
 * (a workspace may not name a provider that runs with the user's authority).
 */
export interface ProviderRegistryEntry {
  /** The slug that selects this provider (`[a-z0-9-]+`, not a built-in id). */
  id: string;
  /** The endpoint root; requests POST to `<baseUrl>/v1/chat/completions`. */
  baseUrl: string;
  /** The codec id; defaults to `openai-chat`, the only value in v1. */
  protocol: ProviderProtocol;
  /** The environment variable that carries the key, if the key is not inline. */
  envKey?: string;
  /** An inline key (lowest-friction; prefer `envKey` to keep keys out of files). */
  apiKey?: string;
  /** Candidate models; the first is the default when none is otherwise set. */
  models?: string[];
}

/** The parsed `providers` config section: what to offer, and what was skipped. */
export interface ProviderRegistry {
  providers: ProviderRegistryEntry[];
  /** One readable line per entry that was malformed and skipped. */
  rejected: string[];
}

/**
 * A registered provider, resolved against the environment: the endpoint, the
 * credential (from the entry or an env var, see `resolveRegistryCredential`) and
 * the default model. `makeProvider` turns this into the openai-compatible
 * adapter; `credential: { kind: "none" }` feeds the FEAT-001 missing-key path
 * when the entry needs a key it cannot find, or runs keyless when it declares no
 * key source at all (a local vLLM).
 */
export interface ResolvedProvider {
  /** The registered id; becomes the adapter's Provider.name. */
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  credential: Credential;
  /** Whether the entry declared a key source at all (apiKey/envKey/HZ_API_KEY). */
  wantsKey: boolean;
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
  providers?: unknown;
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

/** A registered provider id must be a slug, the same grammar MCP ids use. */
const PROVIDER_ID = /^[a-z0-9-]+$/;

/**
 * Validate one `providers[]` entry. Returns the normalized entry, or a readable
 * reason string — never throws: a malformed entry is a named skip (mirrors
 * parseMcpServer), not a startup failure. The protocol defaults to
 * `openai-chat`, the only value in v1; any other value is rejected readably.
 */
export function parseProviderEntry(value: unknown, index: number): ProviderRegistryEntry | string {
  const where = `providers[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} is not an object`;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "" || !PROVIDER_ID.test(id)) {
    return `${where}.id must match [a-z0-9-] (got ${JSON.stringify(raw.id ?? null)})`;
  }
  if ((PROVIDER_NAMES as readonly string[]).includes(id)) {
    return `${where}.id ${JSON.stringify(id)} collides with a built-in provider; choose another id`;
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (baseUrl === "") return `${where}.baseUrl must be a non-empty string`;
  if (!/^https?:\/\//i.test(baseUrl)) return `${where}.baseUrl must be an http(s) URL (got ${JSON.stringify(baseUrl)})`;
  let protocol: ProviderProtocol = "openai-chat";
  if (raw.protocol !== undefined) {
    if (raw.protocol !== "openai-chat") {
      return `${where}.protocol must be "openai-chat" in v1 (got ${JSON.stringify(raw.protocol)})`;
    }
    protocol = raw.protocol;
  }
  let envKey: string | undefined;
  if (raw.envKey !== undefined) {
    if (typeof raw.envKey !== "string" || raw.envKey.trim() === "") return `${where}.envKey must be a non-empty string`;
    envKey = raw.envKey.trim();
  }
  let apiKey: string | undefined;
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string" || raw.apiKey.trim() === "") return `${where}.apiKey must be a non-empty string`;
    apiKey = raw.apiKey.trim();
  }
  let models: string[] | undefined;
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models) || raw.models.some((m) => typeof m !== "string" || m.trim() === "")) {
      return `${where}.models must be an array of non-empty strings`;
    }
    models = (raw.models as string[]).map((m) => m.trim());
  }
  const entry: ProviderRegistryEntry = { id, baseUrl, protocol };
  if (envKey !== undefined) entry.envKey = envKey;
  if (apiKey !== undefined) entry.apiKey = apiKey;
  if (models !== undefined) entry.models = models;
  return entry;
}

/**
 * Parse the `providers` section of the config file. `undefined` means "no
 * providers section" (or nothing usable in it); rejected entries are collected,
 * never thrown — the banner turns them into notices, the same way the MCP
 * section does.
 */
export function parseProviderRegistry(value: unknown): ProviderRegistry | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return { providers: [], rejected: ["providers must be an array"] };
  const providers: ProviderRegistryEntry[] = [];
  const rejected: string[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const parsed = parseProviderEntry(item, index);
    if (typeof parsed === "string") {
      rejected.push(parsed);
      return;
    }
    if (ids.has(parsed.id)) {
      rejected.push(`providers[${index}] duplicates provider id ${JSON.stringify(parsed.id)}; skipped`);
      return;
    }
    ids.add(parsed.id);
    providers.push(parsed);
  });
  if (providers.length === 0 && rejected.length === 0) return undefined;
  return { providers, rejected };
}

/**
 * Resolve a registered entry's credential against the environment. Precedence:
 * an explicit `apiKey` → the entry's `envKey` env var → `HZ_API_KEY` → none.
 * `wantsKey` records whether the entry declared any key source at all: an entry
 * with no apiKey and no envKey (and no HZ_API_KEY) is treated as keyless (a
 * local vLLM), while an entry that wanted a key but could not find one resolves
 * to `{ kind: "none" }` with `wantsKey: true` so makeProvider can explain it.
 */
export function resolveRegistryCredential(entry: ProviderRegistryEntry, env: EnvLike): { credential: Credential; wantsKey: boolean } {
  const wantsKey = entry.apiKey !== undefined || entry.envKey !== undefined;
  const fromApiKey = str(entry.apiKey);
  const fromEnvKey = entry.envKey ? str(env[entry.envKey]) : undefined;
  const fromHz = str(env.HZ_API_KEY);
  const value = fromApiKey ?? fromEnvKey ?? fromHz;
  if (value !== undefined) return { credential: { kind: "apiKey", value }, wantsKey: true };
  return { credential: { kind: "none" }, wantsKey };
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
  const registry = parseProviderRegistry(fromFile.providers);

  // Built-ins resolve FIRST (a registered id may not collide with one anyway);
  // then the registry, by the raw id the user asked for. Anything else is left
  // for the built-in path (an unknown id still falls back to mock here, exactly
  // as before — makeProvider owns the fail-loud default when handed one).
  const rawEnvProvider = str(env.HZ_PROVIDER);
  const rawFileProvider = str(fromFile.provider);
  const envProvider = normalizeProvider(rawEnvProvider);
  const fileProvider = normalizeProvider(rawFileProvider);
  const detected = detectProvider(env);

  const registered = (id: string | undefined): ProviderRegistryEntry | undefined =>
    id !== undefined ? registry?.providers.find((entry) => entry.id === id.toLowerCase()) : undefined;
  const envRegistered = envProvider ? undefined : registered(rawEnvProvider);
  const fileRegistered = envProvider || envRegistered ? undefined : registered(rawFileProvider);
  const selectedEntry = envRegistered ?? fileRegistered;

  const provider: HzConfig["provider"] = envProvider ?? envRegistered?.id ?? fileProvider ?? fileRegistered?.id ?? detected ?? "mock";
  const providerSource: HzConfig["sources"]["provider"] = envProvider || envRegistered
    ? "env"
    : fileProvider || fileRegistered
      ? "file"
      : detected
        ? "detected"
        : "default";

  // A registered provider carries its own endpoint, default model and
  // credential; it reuses the openai-compatible adapter (makeProvider).
  let resolved: ResolvedProvider | undefined;
  if (selectedEntry) {
    const { credential, wantsKey } = resolveRegistryCredential(selectedEntry, env);
    resolved = { name: selectedEntry.id, baseUrl: selectedEntry.baseUrl, protocol: selectedEntry.protocol, credential, wantsKey };
  }

  // The default model for a built-in provider goes THROUGH the catalog
  // (FEAT-003): `builtinDefaultModel` returns the catalog's default when it
  // knows the provider and falls back to DEFAULT_MODELS when it does not. The
  // curated snapshot carries the same ids, so the resolved default equals the
  // historical constant; a catalog miss (offline/curated-gap) still yields it.
  // A registered entry that declares no model (and has no HZ_MODEL/file model)
  // MUST NOT inherit the mock's default id: forwarding "mock-1" to a real host
  // is the opaque-400 silent-wrong-thing the fail-loud default exists to kill,
  // one layer up. Such an entry resolves `model` to the empty-string sentinel
  // ("" = no model configured), which `makeProvider` surfaces as a readable
  // error. A built-in with no explicit model still gets the catalog default
  // (falling back to DEFAULT_MODELS), exactly as before.
  const catalog = loadCatalog(env);
  const envModel = str(env.HZ_MODEL);
  const fileModel = str(fromFile.model);
  const registryModel = selectedEntry?.models?.[0];
  const builtinModel = selectedEntry ? "" : builtinDefaultModel(provider as ProviderName, catalog);
  const model = envModel ?? fileModel ?? registryModel ?? builtinModel ?? builtinDefaultModel("mock", catalog);

  const envBase = str(env.HZ_BASE_URL);
  const fileBase = str(fromFile.baseUrl);
  const defaultBase = selectedEntry
    ? selectedEntry.baseUrl
    : provider === "mock"
      ? undefined
      : DEFAULT_BASE_URLS[provider as Exclude<ProviderName, "mock">];
  const baseUrl = envBase ?? fileBase ?? defaultBase;

  const envKey = str(env.HZ_API_KEY);
  const fileKey = str(fromFile.apiKey);
  const detectedKey = selectedEntry ? undefined : providerKey(provider as ProviderName, env);
  const registryKey = resolved?.credential.kind === "apiKey" ? resolved.credential.value : undefined;
  const apiKey = envKey ?? fileKey ?? detectedKey ?? registryKey;

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

  // Where the registry key came from, for the banner: an inline apiKey or the
  // entry's envKey var read as "file"/"env"; HZ_API_KEY stays "env".
  const registryKeySource: HzConfig["sources"]["apiKey"] | undefined = resolved?.credential.kind === "apiKey"
    ? selectedEntry?.apiKey
      ? "file"
      : "env"
    : undefined;

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    budget: Object.keys(budget).length > 0 ? budget : undefined,
    mcp,
    lsp,
    providers: registry,
    resolved,
    sources: {
      provider: providerSource,
      model: envModel ? "env" : fileModel ? "file" : registryModel ? "file" : "default",
      baseUrl: envBase ? "env" : fileBase ? "file" : "default",
      apiKey: envKey ? "env" : fileKey ? "file" : detectedKey ? "env" : (registryKeySource ?? "none"),
    },
  };
}

/** One short line for the UI: `mock · mock-1` or `anthropic · claude-sonnet-4-5`. */
export function describeConfig(config: HzConfig): string {
  return `${config.provider} \u00b7 ${config.model}`;
}

/** True when the provider needs a key and does not have one yet. */
export function missingKey(config: HzConfig): string | null {
  // A registered provider: it is missing a key only if it declared one it could
  // not find. A keyless entry (no apiKey/envKey) runs without a key.
  if (config.resolved) {
    if (config.resolved.credential.kind !== "none") return null;
    return config.resolved.wantsKey ? "HZ_API_KEY" : null;
  }
  if (config.provider === "mock" || config.provider === "ollama") return null;
  if (config.apiKey) return null;
  return config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : config.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
}

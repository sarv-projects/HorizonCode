/**
 * dap/config.ts — adapter catalogue + resolution (oh-my-pi config.ts / defaults.json @ 21f1188).
 *
 * Reduced form: built-in defaults, optional workspace `.hz/dap.json` overrides, PATH resolve
 * via `Bun.which`. TCP/socket adapters use `transport.ts` (listen announce + connect).
 */

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import DEFAULTS from "./defaults.json" with { type: "json" };

export interface DapAdapterConfig {
  command: string;
  args: string[];
  languages: string[];
  fileTypes: string[];
  rootMarkers: string[];
  launchDefaults: Record<string, unknown>;
  attachDefaults: Record<string, unknown>;
  acceptsDirectoryProgram: boolean;
  connectMode?: "stdio" | "socket" | "tcp";
}

export interface DapResolvedAdapter extends DapAdapterConfig {
  name: string;
  /** Absolute path (or interpreter) suitable for spawnOwned argv[0]. */
  resolvedCommand: string;
}

const JS_DEBUG_SERVER_ENV = "JS_DEBUG_DAP_SERVER";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
  if (!isRecord(config)) return null;
  if (typeof config.command !== "string" || config.command.length === 0) return null;
  const connectMode =
    config.connectMode === "socket" || config.connectMode === "tcp" || config.connectMode === "stdio"
      ? config.connectMode
      : undefined;
  return {
    command: config.command,
    args: stringList(config.args),
    languages: stringList(config.languages),
    fileTypes: stringList(config.fileTypes).map((entry) => entry.toLowerCase()),
    rootMarkers: stringList(config.rootMarkers),
    launchDefaults: objectOrEmpty(config.launchDefaults),
    attachDefaults: objectOrEmpty(config.attachDefaults),
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
    ...(connectMode ? { connectMode } : {}),
  };
}

function builtInAdapters(): Record<string, DapAdapterConfig> {
  const adapters: Record<string, DapAdapterConfig> = {};
  for (const [name, config] of Object.entries(DEFAULTS as Record<string, unknown>)) {
    const normalized = normalizeAdapterConfig(config);
    if (normalized) adapters[name] = normalized;
  }
  return adapters;
}

function mergeAdapters(
  base: Record<string, DapAdapterConfig>,
  overrides: Record<string, unknown>,
): Record<string, DapAdapterConfig> {
  const merged: Record<string, DapAdapterConfig> = { ...base };
  for (const [name, config] of Object.entries(overrides)) {
    const existing = merged[name];
    const candidate =
      existing !== undefined && isRecord(config)
        ? {
            ...existing,
            ...config,
            launchDefaults: { ...existing.launchDefaults, ...objectOrEmpty(config.launchDefaults) },
            attachDefaults: { ...existing.attachDefaults, ...objectOrEmpty(config.attachDefaults) },
          }
        : config;
    const normalized = normalizeAdapterConfig(candidate);
    if (normalized) merged[name] = normalized;
  }
  return merged;
}

/** Load defaults + optional `<workspace>/.hz/dap.json` `{ "adapters": { ... } }`. */
export function loadAdapterConfigs(workspace?: string): Record<string, DapAdapterConfig> {
  let adapters = builtInAdapters();
  if (workspace) {
    const file = path.join(workspace, ".hz", "dap.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const overrides = isRecord(parsed) && isRecord(parsed.adapters) ? parsed.adapters : isRecord(parsed) ? parsed : null;
        if (overrides) adapters = mergeAdapters(adapters, overrides);
      } catch {
        /* ignore invalid override file */
      }
    }
  }
  return adapters;
}

function whichCommand(command: string): string | null {
  if (path.isAbsolute(command) && existsSync(command)) return command;
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(command) ?? null;
  }
  return null;
}

function resolveJsDebugServerPath(cwd: string): string | null {
  const configured = process.env[JS_DEBUG_SERVER_ENV];
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  const candidates = [
    ...(configured ? [path.resolve(cwd, configured)] : []),
    path.join(dataHome, "nvim", "mason", "packages", "js-debug-adapter", "js-debug", "src", "dapDebugServer.js"),
    path.join(os.homedir(), ".local", "opt", "js-debug", "src", "dapDebugServer.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a named adapter to an absolute command. Returns null when the binary is missing
 * (except js-debug special-case when a server script is found).
 */
export function resolveAdapter(name: string, cwd: string, configs = loadAdapterConfigs(cwd)): DapResolvedAdapter | null {
  const config = configs[name];
  if (!config) return null;

  if (name === "js-debug-adapter" && config.command === "js-debug-adapter") {
    const serverPath = resolveJsDebugServerPath(cwd);
    if (!serverPath) return null;
    const node = whichCommand("node") ?? process.execPath;
    return {
      name,
      ...config,
      command: path.basename(node),
      args: [serverPath],
      resolvedCommand: node,
      connectMode: "tcp",
    };
  }

  const commandPath = path.isAbsolute(config.command)
    ? config.command
    : config.command.startsWith("./") || config.command.startsWith("../")
      ? path.resolve(cwd, config.command)
      : config.command;
  const resolved = whichCommand(commandPath);
  if (!resolved) return null;
  return {
    name,
    ...config,
    resolvedCommand: resolved,
  };
}

export function listResolvedAdapters(cwd: string): DapResolvedAdapter[] {
  const configs = loadAdapterConfigs(cwd);
  return Object.keys(configs)
    .map((name) => resolveAdapter(name, cwd, configs))
    .filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function hasRootMarker(dir: string, markers: string[]): boolean {
  for (const marker of markers) {
    if (marker.includes("*")) continue; // glob markers skipped in reduced form
    if (existsSync(path.join(dir, marker))) return true;
  }
  return false;
}

function findRootDir(program: string, cwd: string, markers: string[]): string | null {
  if (markers.length === 0) return null;
  let dir = path.dirname(path.resolve(cwd, program));
  for (;;) {
    if (hasRootMarker(dir, markers)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Pick the best available adapter for a program path (extension + root markers).
 * Prefers stdio when both kinds match; tcp/socket adapters are eligible (transport.ts).
 */
export function selectAdapterForProgram(program: string, cwd: string): DapResolvedAdapter | null {
  const configs = loadAdapterConfigs(cwd);
  const extension = path.extname(program).toLowerCase();
  const candidates: Array<{ adapter: DapResolvedAdapter; ext: boolean; root: boolean; stdio: boolean }> = [];
  for (const name of Object.keys(configs)) {
    const config = configs[name]!;
    if (extension && config.fileTypes.length > 0 && !config.fileTypes.includes(extension)) continue;
    const adapter = resolveAdapter(name, cwd, configs);
    if (!adapter) continue;
    const mode = adapter.connectMode ?? "stdio";
    candidates.push({
      adapter,
      ext: extension.length > 0 && adapter.fileTypes.includes(extension),
      root: findRootDir(program, cwd, adapter.rootMarkers) !== null,
      stdio: mode === "stdio",
    });
  }
  candidates.sort((a, b) => {
    if (a.ext !== b.ext) return a.ext ? -1 : 1;
    if (a.root !== b.root) return a.root ? -1 : 1;
    if (a.stdio !== b.stdio) return a.stdio ? -1 : 1;
    return a.adapter.name.localeCompare(b.adapter.name);
  });
  return candidates[0]?.adapter ?? null;
}

/** Describe catalogue entries (resolved or not) for doctor / tool errors. */
export function describeAdapterCatalogue(cwd: string): Array<{ name: string; command: string; available: boolean }> {
  const configs = loadAdapterConfigs(cwd);
  return Object.entries(configs).map(([name, config]) => ({
    name,
    command: config.command,
    available: resolveAdapter(name, cwd, configs) !== null,
  }));
}

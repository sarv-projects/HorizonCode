/**
 * H-3 residual (ruling **484**) + H-4 (ruling **494**): config keys that name a
 * class via short name or documented import path (mini-swe item 17; aider-style
 * alias map).
 *
 * Closed maps only — no dynamic import of arbitrary paths, no plugin registry.
 * Unknown specs fail with a readable error that lists the known short names.
 *
 * `formatMessageClass` is the additive H-4 key: its map values are built-in
 * FORMATTER DIALECT IDS (not module paths). A static selector in
 * `providers/message-formatter.ts` maps those ids to built-in implementations;
 * nothing is imported dynamically and no new dependency is introduced.
 */

/** Known class-name config keys (camelCase; snake_case accepted at parse). */
export type ConfigClassKey = "providerClass" | "modelClass" | "formatMessageClass";

export const CONFIG_CLASS_KEYS: readonly ConfigClassKey[] = [
  "providerClass",
  "modelClass",
  "formatMessageClass",
];

/**
 * Short name → stable module path under `app/src` (slash form).
 * Aider-style aliases: short names resolve; full paths that match a value also resolve.
 */
export const PROVIDER_CLASS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  openai: "core/providers/openai",
  anthropic: "core/providers/anthropic",
  google: "core/providers/google",
  ollama: "core/providers/ollama",
  mock: "core/providers/mock",
  "openai-compatible": "core/providers/openai-compatible",
});

/**
 * Model-class short names → modules that own wire formatting today (H-4 still
 * open for a swappable `format_message` class). Same closed-map posture.
 */
export const MODEL_CLASS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  openai: "core/providers/openai",
  anthropic: "core/providers/anthropic",
  google: "core/providers/google",
  ollama: "core/providers/ollama",
  mock: "core/providers/mock",
});

/**
 * H-4 format_message class-key map: short name → BUILT-IN FORMATTER DIALECT ID.
 * Unlike the two maps above, values are dialect ids, not import paths: the
 * formatter is selected statically from `providers/message-formatter.ts` and no
 * module is loaded dynamically. `mock` and `openai-compatible` reuse the OpenAI
 * chat dialect because their wire shape is OpenAI-compatible.
 */
export const FORMATTER_CLASS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai",
  "openai-compatible": "openai",
  anthropic: "anthropic",
  google: "google",
  ollama: "ollama",
  mock: "openai",
});

const ALIAS_BY_KEY: Record<ConfigClassKey, Readonly<Record<string, string>>> = {
  providerClass: PROVIDER_CLASS_ALIASES,
  modelClass: MODEL_CLASS_ALIASES,
  formatMessageClass: FORMATTER_CLASS_ALIASES,
};

export interface ResolvedConfigClass {
  key: ConfigClassKey;
  /** Original trimmed spec from config. */
  spec: string;
  /** Canonical slash module path under `app/src`. */
  modulePath: string;
  via: "short-name" | "import-path";
}

export class ConfigClassResolveError extends Error {
  readonly key: ConfigClassKey;
  readonly spec: string;
  readonly knownShortNames: readonly string[];

  constructor(key: ConfigClassKey, spec: string, knownShortNames: readonly string[]) {
    const listed = knownShortNames.join(", ");
    super(
      `Unknown ${key} ${JSON.stringify(spec)}. ` +
        `Use a short name (${listed}) or a documented import path from that map. ` +
        `Arbitrary module paths are not loaded (no plugin registry).`,
    );
    this.name = "ConfigClassResolveError";
    this.key = key;
    this.spec = spec;
    this.knownShortNames = knownShortNames;
  }
}

/** Normalize snake_case / camelCase key tokens onto the closed key set. */
export function normalizeConfigClassKey(raw: string): ConfigClassKey | undefined {
  const t = raw.trim();
  if (t === "providerClass" || t === "provider_class") return "providerClass";
  if (t === "modelClass" || t === "model_class") return "modelClass";
  if (t === "formatMessageClass" || t === "format_message_class") return "formatMessageClass";
  return undefined;
}

/** Slash-normalize a dotted or slashed path; strip leading `./` and `app/src/`. */
export function normalizeConfigClassImportPath(spec: string): string {
  let s = spec.trim().replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("app/src/")) s = s.slice("app/src/".length);
  s = s.replace(/\./g, "/");
  // Undo accidental double-slash from empty segments.
  s = s.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  // Dotted paths used `/` for package separators; restore file-ish trailing
  // segment that was already slash (noop). Collapse `core/providers/openai`
  // when input was `core.providers.openai`.
  return s;
}

function reverseLookup(
  aliases: Readonly<Record<string, string>>,
  modulePath: string,
): string | undefined {
  for (const [shortName, path] of Object.entries(aliases)) {
    if (path === modulePath) return shortName;
  }
  return undefined;
}

/**
 * Resolve a class-name config value: short name (aider alias) or documented
 * import path that matches a map value. Does not import the module.
 */
export function resolveConfigClassKey(key: ConfigClassKey, rawSpec: string): ResolvedConfigClass {
  const spec = rawSpec.trim();
  if (spec === "") {
    throw new ConfigClassResolveError(key, rawSpec, listConfigClassShortNames(key));
  }
  const aliases = ALIAS_BY_KEY[key];
  const short = aliases[spec];
  if (short !== undefined) {
    return { key, spec, modulePath: short, via: "short-name" };
  }
  const asPath = normalizeConfigClassImportPath(spec);
  if (reverseLookup(aliases, asPath) !== undefined) {
    return { key, spec, modulePath: asPath, via: "import-path" };
  }
  throw new ConfigClassResolveError(key, spec, listConfigClassShortNames(key));
}

export function listConfigClassShortNames(key: ConfigClassKey): string[] {
  return Object.keys(ALIAS_BY_KEY[key]).sort();
}

/**
 * Parse optional class-name fields from a config object (camel or snake).
 * Unknown / empty specs become a rejection string (startup must not throw).
 */
export function parseConfigClassFields(raw: Record<string, unknown>): {
  providerClass?: ResolvedConfigClass;
  modelClass?: ResolvedConfigClass;
  formatMessageClass?: ResolvedConfigClass;
  providerClassRejected?: string;
  modelClassRejected?: string;
  formatMessageClassRejected?: string;
} {
  const out: {
    providerClass?: ResolvedConfigClass;
    modelClass?: ResolvedConfigClass;
    formatMessageClass?: ResolvedConfigClass;
    providerClassRejected?: string;
    modelClassRejected?: string;
    formatMessageClassRejected?: string;
  } = {};

  const providerRaw = pickClassSpec(raw, "providerClass", "provider_class");
  if (providerRaw !== undefined) {
    try {
      out.providerClass = resolveConfigClassKey("providerClass", providerRaw);
    } catch (err) {
      out.providerClassRejected = err instanceof Error ? err.message : String(err);
    }
  }

  const modelRaw = pickClassSpec(raw, "modelClass", "model_class");
  if (modelRaw !== undefined) {
    try {
      out.modelClass = resolveConfigClassKey("modelClass", modelRaw);
    } catch (err) {
      out.modelClassRejected = err instanceof Error ? err.message : String(err);
    }
  }

  const formatterRaw = pickClassSpec(raw, "formatMessageClass", "format_message_class");
  if (formatterRaw !== undefined) {
    try {
      out.formatMessageClass = resolveConfigClassKey("formatMessageClass", formatterRaw);
    } catch (err) {
      out.formatMessageClassRejected = err instanceof Error ? err.message : String(err);
    }
  }

  return out;
}

function pickClassSpec(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  const a = raw[camel];
  const b = raw[snake];
  const value = a !== undefined ? a : b;
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

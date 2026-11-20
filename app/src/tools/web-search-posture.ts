/**
 * `web_search` backend posture — env-gated, fail-closed when unset (docs/09 §4.4).
 */

import type { EnvLike } from "../core/config";

const DDG_HTML = "https://html.duckduckgo.com/html/";
const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";

export type WebSearchBackend =
  | { kind: "disabled"; reason: string }
  | { kind: "duckduckgo-html"; requestUrlForQuery: (query: string) => string }
  | { kind: "template"; label: string; requestUrlForQuery: (query: string) => string }
  | { kind: "brave"; requestUrlForQuery: (query: string) => string; apiKey: string };

function envRecord(env: EnvLike): Record<string, string | undefined> {
  return env as Record<string, string | undefined>;
}

function truthyOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const t = raw.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function explicitOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const t = raw.trim().toLowerCase();
  return t === "0" || t === "false" || t === "no" || t === "off";
}

function searchTemplate(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_WEB_SEARCH_URL ?? env.HZ_WEB_SEARCH_ENDPOINT;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed !== "" ? trimmed : undefined;
}

function templateRequestUrl(template: string, query: string): string {
  if (template.includes("{query}")) return template.split("{query}").join(encodeURIComponent(query));
  return `${template}${template.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
}

function braveApiKey(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_WEB_SEARCH_API_KEY ?? env.BRAVE_SEARCH_API_KEY;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed !== "" ? trimmed : undefined;
}

/** Resolve the configured search backend from environment (never performs I/O). */
export function assessWebSearchBackend(env: EnvLike): WebSearchBackend {
  const e = envRecord(env);
  if (explicitOff(e.HZ_WEB_SEARCH)) {
    return { kind: "disabled", reason: "HZ_WEB_SEARCH=0" };
  }

  const template = searchTemplate(e);
  if (template !== undefined) {
    return {
      kind: "template",
      label: "configured-url",
      requestUrlForQuery: (query) => templateRequestUrl(template, query),
    };
  }

  const provider = (e.HZ_WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "brave") {
    const apiKey = braveApiKey(e);
    if (apiKey === undefined) {
      return {
        kind: "disabled",
        reason: "HZ_WEB_SEARCH_PROVIDER=brave requires HZ_WEB_SEARCH_API_KEY or BRAVE_SEARCH_API_KEY",
      };
    }
    return {
      kind: "brave",
      apiKey,
      requestUrlForQuery: (query) => `${BRAVE_SEARCH}?q=${encodeURIComponent(query)}`,
    };
  }

  if (truthyOn(e.HZ_WEB_SEARCH)) {
    return {
      kind: "duckduckgo-html",
      requestUrlForQuery: (query) => `${DDG_HTML}?q=${encodeURIComponent(query)}`,
    };
  }

  return {
    kind: "disabled",
    reason:
      "set HZ_WEB_SEARCH=1 (DuckDuckGo HTML), HZ_WEB_SEARCH_URL, or HZ_WEB_SEARCH_PROVIDER=brave with an API key",
  };
}

export function webSearchBackendEnabled(backend: WebSearchBackend): backend is Exclude<WebSearchBackend, { kind: "disabled" }> {
  return backend.kind !== "disabled";
}

/** HTTPS URL used for kernel `net.fetch` admission and the outbound GET. */
export function guardTargetForWebSearchQuery(query: string, env: EnvLike): string | undefined {
  const backend = assessWebSearchBackend(env);
  if (!webSearchBackendEnabled(backend)) return undefined;
  const url = backend.requestUrlForQuery(query);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function webSearchBackendLabel(backend: WebSearchBackend): string {
  switch (backend.kind) {
    case "disabled":
      return `disabled (${backend.reason})`;
    case "duckduckgo-html":
      return "duckduckgo-html (HZ_WEB_SEARCH=1; ambient Bun fetch; shell-net not enforced)";
    case "template":
      return `${backend.label} (HZ_WEB_SEARCH_URL; ambient Bun fetch; shell-net not enforced)`;
    case "brave":
      return "brave-api (HZ_WEB_SEARCH_PROVIDER=brave; ambient Bun fetch; shell-net not enforced)";
    default:
      return "unknown";
  }
}
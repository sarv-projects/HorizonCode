/**
 * `web_search` — query a search backend and return ranked snippets.
 *
 * Backends are env-gated (fail-closed by default):
 * - `HZ_WEB_SEARCH=1` — DuckDuckGo HTML (no API key)
 * - `HZ_WEB_SEARCH_URL` / `HZ_WEB_SEARCH_ENDPOINT` — custom GET template
 * - `HZ_WEB_SEARCH_PROVIDER=brave` + `BRAVE_SEARCH_API_KEY` or `HZ_WEB_SEARCH_API_KEY`
 *
 * Authority: kernel `net.fetch` via loop admission and in-tool `ctx.guard`.
 * HTTP uses ambient `fetch` (Bun); no routed egress proxy — shell-net is **not**
 * enforced.
 */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import { checkDnsNotPrivate, isBlockedPrivateHost, readBodyCapped, stripHtmlToText } from "./web-fetch";
import { truncate } from "./helpers";
import { assessWebSearchBackend, webSearchBackendEnabled, type WebSearchBackend } from "./web-search-posture";

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 80_000;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-subscription-token",
]);

function normalizeHttpsUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    if (process.env.HZ_ALLOW_PRIVATE_FETCH !== "1" && isBlockedPrivateHost(u.hostname)) {
      return undefined;
    }
    return u.href;
  } catch {
    return undefined;
  }
}

function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!AUTH_HEADER_NAMES.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
const DDG_HTML = "https://html.duckduckgo.com/html/";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchHttp = (url: string, init: RequestInit) => Promise<Response>;

let httpFetch: WebSearchHttp = (url, init) => fetch(url, init);
let usingCustomHttp = false;

/** Test hook: replace the HTTP layer; pass `undefined` to restore Bun `fetch`. */
export function __setWebSearchHttpForTests(impl: WebSearchHttp | undefined): void {
  usingCustomHttp = impl !== undefined;
  httpFetch = impl ?? ((url, init) => fetch(url, init));
}

/* -------------------- query budget & rate metering -------------------- */

export const DEFAULT_MAX_QUERIES_PER_TURN = 15;
export const DEFAULT_MAX_RPM = 30;
export const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_SESSION_COUNTERS = 256;

let rateLimiterState = {
  turnQueryCounts: new Map<string, number>(),
  timestamps: [] as number[],
  cache: new Map<string, { result: ToolResult; expiresAt: number }>(),
};

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** Reset only the per-turn query counter (preserving RPM window and result cache). */
export function resetWebSearchTurnBudget(sessionId?: string): void {
  if (sessionId !== undefined) {
    rateLimiterState.turnQueryCounts.delete(sessionId);
  } else {
    rateLimiterState.turnQueryCounts.clear();
  }
}

/** Reset query budget, rate limiter timestamps, and query cache (used in tests and turn boundaries). */
export function __resetWebSearchBudgetForTests(): void {
  rateLimiterState = {
    turnQueryCounts: new Map(),
    timestamps: [],
    cache: new Map(),
  };
}

export function getWebSearchBudgetStats(sessionId?: string): {
  turnQueryCount: number;
  recentRpm: number;
  cachedEntries: number;
} {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = rateLimiterState.timestamps.filter((t) => t >= windowStart).length;
  let turnQueryCount = 0;
  if (sessionId !== undefined) {
    turnQueryCount = rateLimiterState.turnQueryCounts.get(sessionId) ?? 0;
  } else {
    for (const c of rateLimiterState.turnQueryCounts.values()) turnQueryCount += c;
  }
  return {
    turnQueryCount,
    recentRpm: recent,
    cachedEntries: rateLimiterState.cache.size,
  };
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Build the GET URL for a query using `process.env` (tests may preset env). */
export function searchRequestUrl(query: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const backend = assessWebSearchBackend(env);
  if (!webSearchBackendEnabled(backend)) return undefined;
  return backend.requestUrlForQuery(query);
}

function normalizeDdgHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  try {
    const u = new URL(trimmed, DDG_HTML);
    if (u.hostname === "duckduckgo.com" && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return u.href;
  } catch {
    return trimmed;
  }
}

/** Parse DuckDuckGo HTML result rows (best-effort). */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let block: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((block = blockRe.exec(html)) !== null && results.length < limit) {
    const chunk = block[1] ?? "";
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!link) continue;
    const url = normalizeDdgHref(link[1] ?? "");
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    const title = stripHtmlToText(link[2] ?? "").replace(/\s+/g, " ").trim();
    const snippetMatch =
      /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk) ??
      /<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    const snippet = snippetMatch ? stripHtmlToText(snippetMatch[1] ?? "").replace(/\s+/g, " ").trim() : "";
    results.push({ title: title || url, url, snippet });
  }
  if (results.length > 0) return results;

  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = normalizeDdgHref(m[1] ?? "");
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    const title = stripHtmlToText(m[2] ?? "").replace(/\s+/g, " ").trim();
    results.push({ title: title || url, url, snippet: "" });
  }
  return results;
}

/** Parse Brave Web Search API JSON (best-effort). */
export function parseBraveSearchJson(body: string, limit: number): WebSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  const web = parsed && typeof parsed === "object" && "web" in parsed ? (parsed as { web?: unknown }).web : undefined;
  const resultsRaw =
    web && typeof web === "object" && "results" in web ? (web as { results?: unknown }).results : undefined;
  if (!Array.isArray(resultsRaw)) return [];
  const out: WebSearchResult[] = [];
  for (const row of resultsRaw) {
    if (out.length >= limit) break;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (url === "") continue;
    const title = typeof r.title === "string" ? r.title.trim() : url;
    const snippet =
      typeof r.description === "string"
        ? r.description.trim()
        : typeof r.snippet === "string"
          ? r.snippet.trim()
          : "";
    out.push({ title, url, snippet });
  }
  return out;
}

function backendWireLabel(backend: WebSearchBackend): string {
  switch (backend.kind) {
    case "duckduckgo-html":
      return "duckduckgo-html";
    case "template":
      return "configured";
    case "brave":
      return "brave-api";
    default:
      return "unknown";
  }
}

function parseResults(backend: WebSearchBackend, body: string, limit: number): WebSearchResult[] {
  if (backend.kind === "brave") return parseBraveSearchJson(body, limit);
  return parseDuckDuckGoHtml(body, limit);
}

async function checkNetFetch(ctx: ToolContext, url: string): Promise<string | null> {
  const action: GuardAction = { kind: "net.fetch", target: url };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `Search ${url}`, detail: url, kind: "net.fetch" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

function formatResults(query: string, backend: string, results: WebSearchResult[]): string {
  const lines = [
    `query: ${query}`,
    `backend: ${backend}`,
    `count: ${results.length}`,
    "",
    ...results.flatMap((r, i) => [
      `${i + 1}. ${r.title}`,
      `   url: ${r.url}`,
      r.snippet !== "" ? `   ${r.snippet}` : "",
      "",
    ]),
  ];
  return lines.join("\n").trimEnd();
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for ranked titles, URLs, snippets. Fail-closed unless HZ_WEB_SEARCH=1 (DuckDuckGo HTML), HZ_WEB_SEARCH_URL, or HZ_WEB_SEARCH_PROVIDER=brave + API key. net.fetch Guard; ambient Bun fetch (shell-net not enforced).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string." },
      count: {
        type: "integer",
        description: `Number of results (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`,
        minimum: 1,
        maximum: MAX_COUNT,
      },
      timeout_ms: {
        type: "integer",
        description: `Request timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["query"],
  },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return fail("query is required");

    const backend = assessWebSearchBackend(process.env);
    if (!webSearchBackendEnabled(backend)) {
      return fail(`web search backend not configured: ${backend.reason}`);
    }

    const countRaw = args.count;
    const count =
      typeof countRaw === "number" && Number.isFinite(countRaw)
        ? Math.min(MAX_COUNT, Math.max(1, Math.floor(countRaw)))
        : DEFAULT_COUNT;

    const timeoutRaw = args.timeout_ms;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(timeoutRaw)))
        : DEFAULT_TIMEOUT_MS;

    const rawUrl = backend.requestUrlForQuery(query);
    const url = normalizeHttpsUrl(rawUrl);
    if (url === undefined) return fail("search endpoint must be a valid public https:// URL (no userinfo or private host)");

    const denied = await checkNetFetch(ctx, url);
    if (denied) return fail(denied);

    const cacheKey = `${backend.kind}:${query.toLowerCase()}:${count}`;
    const now = Date.now();
    const cached = rateLimiterState.cache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.result;
    }

    const sessionKey = ctx.sessionId || "_default";
    const sessionCount = rateLimiterState.turnQueryCounts.get(sessionKey) ?? 0;
    const maxTurnQueries = Number(process.env.HZ_WEB_SEARCH_MAX_QUERIES) || DEFAULT_MAX_QUERIES_PER_TURN;
    if (sessionCount >= maxTurnQueries) {
      return fail(`web search budget exceeded: limit of ${maxTurnQueries} queries per turn reached`);
    }

    const maxRpm = Number(process.env.HZ_WEB_SEARCH_RPM) || DEFAULT_MAX_RPM;
    const windowStart = now - 60_000;
    rateLimiterState.timestamps = rateLimiterState.timestamps.filter((t) => t >= windowStart);
    if (rateLimiterState.timestamps.length >= maxRpm) {
      return fail(`web search rate limit exceeded: max ${maxRpm} queries per minute reached`);
    }

    rateLimiterState.timestamps.push(now);
    setBoundedMap(rateLimiterState.turnQueryCounts, sessionKey, sessionCount + 1, MAX_SESSION_COUNTERS);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      accept: backend.kind === "brave" ? "application/json" : "text/html,application/xhtml+xml",
      "user-agent": "HorizonCode-web_search/1.0",
    };
    if (backend.kind === "brave") {
      headers["x-subscription-token"] = backend.apiKey;
    }

    try {
      let currentUrl = url;
      let currentHeaders: Record<string, string> = { ...headers };
      let res: Response;
      let hops = 0;
      for (;;) {
        const dnsErr = await checkDnsNotPrivate(currentUrl, { customFetchInjected: usingCustomHttp });
        if (dnsErr !== null) return fail(dnsErr);
        res = await httpFetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: currentHeaders,
        });
        if (!REDIRECT_STATUSES.has(res.status)) break;
        const location = res.headers.get("location");
        if (!location) break;
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          return fail(`too many redirects (max ${MAX_REDIRECT_HOPS})`);
        }
        let nextRaw: string;
        try {
          nextRaw = new URL(location, currentUrl).href;
        } catch {
          return fail(`invalid redirect location: ${location.replace(/([?&](?:api[-_]?key|key|token|access[-_]?token|secret|auth|password|subscription[-_]?key)=)[^&#]*/gi, "$1[REDACTED]")}`);
        }
        const nextUrl = normalizeHttpsUrl(nextRaw);
        if (nextUrl === undefined) {
          return fail("redirect target must be a valid https:// URL (no userinfo)");
        }
        const redirectDenied = await checkNetFetch(ctx, nextUrl);
        if (redirectDenied) return fail(redirectDenied);
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          currentHeaders = stripAuthHeaders(currentHeaders);
        }
        currentUrl = nextUrl;
      }

      const { text: body, bytes } = await readBodyCapped(res, DEFAULT_MAX_BYTES);

      if (!res.ok) {
        const safeUrl = currentUrl.replace(/([?&](?:api[-_]?key|key|token|access[-_]?token|secret|auth|password|subscription[-_]?key)=)[^&#]*/gi, "$1[REDACTED]");
        return {
          ok: false,
          output: truncate(`url: ${safeUrl}\nstatus: ${res.status}\nbytes: ${bytes}\n\n${body.slice(0, 4000)}`, MAX_OUTPUT_CHARS),
          error: `HTTP ${res.status}`,
        };
      }

      const wireBackend = backendWireLabel(backend);
      const results = parseResults(backend, body, count);
      const formatted = formatResults(query, wireBackend, results);
      const output = truncate(formatted, MAX_OUTPUT_CHARS);

      const successResult: ToolResult = {
        ok: true,
        output:
          results.length === 0
            ? `${output}\n\n(no parseable results — response may use an unsupported layout)`
            : output,
      };
      setBoundedMap(
        rateLimiterState.cache,
        cacheKey,
        { result: successResult, expiresAt: Date.now() + CACHE_TTL_MS },
        MAX_CACHE_ENTRIES,
      );
      return successResult;
    } catch (e) {
      tunnelPermissionError(e);
      if (controller.signal.aborted) {
        const reason = ctx.signal.aborted ? "aborted" : "timeout";
        return fail(`search ${reason}`);
      }
      return fail(`search failed: ${msg(e)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
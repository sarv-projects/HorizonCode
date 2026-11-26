/**
 * stateless-http.ts — Stateless MCP 2026-07-28 HTTP transport & catalog stability helpers.
 *
 * Supports optional stateless mode over HTTP POST:
 * - Emits `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, and `Mcp-Name` headers.
 * - Parses `ttlMs` and `cacheScope` metadata from tool/result payloads or HTTP headers.
 * - Provides deterministic alphabetical tool catalog sorting for prompt-cache stability.
 */

import {
  McpAbortedError,
  McpError,
  McpProtocolError,
  McpRpcError,
  McpTimeoutError,
  McpTransportError,
  normalizeCallResult,
  parseToolsList,
  type McpCallResult,
  type McpToolCaller,
  type McpToolInfo,
} from "./client";

export const MCP_STATELESS_PROTOCOL_VERSION = "2026-07-28";
export const MCP_HEADER_METHOD = "Mcp-Method";
export const MCP_HEADER_NAME = "Mcp-Name";
export const MCP_HEADER_PROTOCOL_VERSION = "MCP-Protocol-Version";

export type McpCacheScope = "session" | "workspace" | "global" | "none" | string;

export interface McpToolCacheMeta {
  ttlMs?: number;
  cacheScope?: McpCacheScope;
}

export interface StatelessMcpHeadersOptions {
  method: string;
  name?: string;
  protocolVersion?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Build stateless MCP 2026-07-28 HTTP headers (`Mcp-Method`, optional `Mcp-Name`,
 * and `MCP-Protocol-Version`).
 */
export function buildStatelessMcpHeaders(opts: StatelessMcpHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...(opts.extraHeaders ?? {}),
    "Content-Type": "application/json",
    Accept: "application/json",
    [MCP_HEADER_PROTOCOL_VERSION]: opts.protocolVersion ?? MCP_STATELESS_PROTOCOL_VERSION,
    [MCP_HEADER_METHOD]: opts.method,
  };
  if (typeof opts.name === "string" && opts.name.trim() !== "") {
    headers[MCP_HEADER_NAME] = opts.name.trim();
  }
  return headers;
}

function readHeaderCaseInsensitive(
  headers: Headers | Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(key);
    return val === null ? undefined : val;
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseFiniteNonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse `ttlMs` and `cacheScope` metadata from an MCP JSON payload (`raw`,
 * `raw._meta`, `raw.annotations`) and/or HTTP response headers (`Cache-Control: max-age=...`,
 * `X-Mcp-Ttl-Ms`, `X-Mcp-Cache-Scope`).
 */
export function parseMcpCacheMetadata(
  raw: unknown,
  headers?: Headers | Record<string, string>,
): McpToolCacheMeta {
  let ttlMs: number | undefined;
  let cacheScope: McpCacheScope | undefined;

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const meta =
      rec._meta !== null && typeof rec._meta === "object" && !Array.isArray(rec._meta)
        ? (rec._meta as Record<string, unknown>)
        : undefined;
    const annotations =
      rec.annotations !== null && typeof rec.annotations === "object" && !Array.isArray(rec.annotations)
        ? (rec.annotations as Record<string, unknown>)
        : undefined;

    ttlMs =
      parseFiniteNonNegNumber(rec.ttlMs) ??
      parseFiniteNonNegNumber(meta?.ttlMs) ??
      parseFiniteNonNegNumber(annotations?.ttlMs);

    cacheScope =
      parseNonEmptyString(rec.cacheScope) ??
      parseNonEmptyString(meta?.cacheScope) ??
      parseNonEmptyString(annotations?.cacheScope);
  }

  if (headers) {
    if (ttlMs === undefined) {
      const headerTtl = readHeaderCaseInsensitive(headers, "X-Mcp-Ttl-Ms");
      ttlMs = parseFiniteNonNegNumber(headerTtl);
    }
    if (ttlMs === undefined) {
      const cc = readHeaderCaseInsensitive(headers, "Cache-Control");
      if (cc) {
        const match = /max-age\s*=\s*(\d+)/i.exec(cc);
        if (match?.[1]) {
          const secs = Number(match[1]);
          if (Number.isFinite(secs) && secs >= 0) ttlMs = secs * 1000;
        }
      }
    }
    if (cacheScope === undefined) {
      cacheScope = parseNonEmptyString(readHeaderCaseInsensitive(headers, "X-Mcp-Cache-Scope"));
    }
  }

  const out: McpToolCacheMeta = {};
  if (ttlMs !== undefined) out.ttlMs = ttlMs;
  if (cacheScope !== undefined) out.cacheScope = cacheScope;
  return out;
}

/**
 * Deterministic alphabetical (locale-independent ASCII code-point) sort for
 * MCP tool catalogs so prompt-cache prefixes remain byte-stable across turns.
 */
export function sortMcpToolCatalog<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface McpStatelessHttpClientOptions {
  serverId: string;
  endpointUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  protocolVersion?: string;
  /** Optional custom fetch implementation (primarily for tests). */
  fetchImpl?: typeof fetch;
}

export interface StatelessListToolsResult {
  tools: McpToolInfo[];
  cacheMeta: McpToolCacheMeta;
}

export interface StatelessCallToolResult extends McpCallResult {
  cacheMeta: McpToolCacheMeta;
}

const DEFAULT_STATELESS_TIMEOUT_MS = 30_000;

/**
 * Optional stateless MCP 2026-07-28 HTTP client.
 * Each JSON-RPC request is self-contained (no session handshake required) and
 * sends `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version` headers.
 */
export class McpStatelessHttpClient implements McpToolCaller {
  readonly serverId: string;
  readonly endpointUrl: string;
  readonly protocolVersion: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(opts: McpStatelessHttpClientOptions) {
    if (typeof opts?.serverId !== "string" || opts.serverId.trim() === "") {
      throw new McpError("config", String(opts?.serverId ?? ""), "serverId is required");
    }
    if (typeof opts?.endpointUrl !== "string" || opts.endpointUrl.trim() === "") {
      throw new McpError("config", opts.serverId, "endpointUrl is required");
    }
    this.serverId = opts.serverId.trim();
    this.endpointUrl = opts.endpointUrl.trim();
    this.protocolVersion = opts.protocolVersion ?? MCP_STATELESS_PROTOCOL_VERSION;
    this.extraHeaders = opts.headers ? { ...opts.headers } : {};
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_STATELESS_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listTools(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<StatelessListToolsResult> {
    const { result, responseHeaders } = await this.rpcPost("tools/list", {}, undefined, opts);
    const parsed = parseToolsList(result, this.serverId);
    const sorted = sortMcpToolCatalog(parsed);
    const cacheMeta = parseMcpCacheMetadata(result, responseHeaders);
    return { tools: sorted, cacheMeta };
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<StatelessCallToolResult> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new McpError("config", this.serverId, "tool name is required");
    }
    const params = {
      name,
      arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {},
    };
    const { result, responseHeaders } = await this.rpcPost("tools/call", params, name, opts);
    const normalized = normalizeCallResult(result);
    const cacheMeta = parseMcpCacheMetadata(result, responseHeaders);
    return { ...normalized, cacheMeta };
  }

  private async rpcPost(
    method: string,
    params: unknown,
    name: string | undefined,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ result: unknown; responseHeaders: Headers }> {
    if (opts.signal?.aborted) {
      throw new McpAbortedError(this.serverId, `${method}: aborted`);
    }
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const onParentAbort = (): void => controller.abort();
    if (opts.signal) {
      opts.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers = buildStatelessMcpHeaders({
        method,
        name,
        protocolVersion: this.protocolVersion,
        extraHeaders: this.extraHeaders,
      });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      });
      const response = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new McpTransportError(
          this.serverId,
          `${method}: HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new McpProtocolError(
          this.serverId,
          `${method}: invalid JSON response (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new McpProtocolError(this.serverId, `${method}: JSON-RPC response must be an object`);
      }
      const msg = payload as Record<string, unknown>;
      if ("error" in msg && msg.error !== null && msg.error !== undefined) {
        const rpcErr = msg.error as { code?: unknown; message?: unknown };
        const code = typeof rpcErr.code === "number" ? rpcErr.code : undefined;
        const text = typeof rpcErr.message === "string" ? rpcErr.message : JSON.stringify(rpcErr);
        throw new McpRpcError(this.serverId, code, `${method}: ${text}`);
      }
      return { result: msg.result, responseHeaders: response.headers };
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (timedOut) {
        throw new McpTimeoutError(this.serverId, `${method}: no response within ${timeoutMs}ms`);
      }
      if (opts.signal?.aborted) {
        throw new McpAbortedError(this.serverId, `${method}: aborted`);
      }
      throw new McpTransportError(
        this.serverId,
        `${method}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onParentAbort);
      }
    }
  }
}

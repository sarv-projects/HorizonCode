/**
 * list-pagination.ts — MCP `tools/list` / `resources/list` cursor passthrough
 * (docs/09 §4.7 reduced form; docs/30 §8 #13 MCP proxy residual).
 *
 * The protocol may return `nextCursor` on a list result; the client must pass it
 * back as `cursor` on the following request until the field is absent. This module
 * is the one place that loops that contract for discovery — handshake and
 * `notifications/tools/list_changed` both call `listAllMcpTools`, not a single page.
 */

import { McpProtocolError, parseResourcesList, parseToolsList, type McpResourceInfo, type McpToolInfo } from "./client";

/** Hard cap on list pages per discovery (fail-closed on runaway servers). */
export const MCP_LIST_MAX_PAGES = 64;

/** Request params for one paginated MCP list call (`cursor` omitted on the first page). */
export function mcpListRequestParams(cursor?: string): Record<string, unknown> {
  if (typeof cursor === "string" && cursor.trim() !== "") return { cursor: cursor.trim() };
  return {};
}

/** Read `nextCursor` from a list result; absent or junk means no further page. */
export function parseMcpListNextCursor(result: unknown): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const cursor = (result as { nextCursor?: unknown }).nextCursor;
  if (typeof cursor !== "string") return undefined;
  const trimmed = cursor.trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ListAllMcpToolsOptions {
  maxPages?: number;
}

export type ListAllMcpListOptions = ListAllMcpToolsOptions;

async function listAllMcpListPages<T>(
  listPage: (cursor?: string) => Promise<unknown>,
  parsePage: (result: unknown, serverId: string) => T[],
  keyOf: (item: T) => string,
  serverId: string,
  methodLabel: string,
  opts: ListAllMcpListOptions = {},
): Promise<T[]> {
  const maxPages =
    opts.maxPages !== undefined && opts.maxPages > 0 ? Math.floor(opts.maxPages) : MCP_LIST_MAX_PAGES;
  const merged: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listPage(cursor);
    const pageItems = parsePage(result, serverId);
    for (const item of pageItems) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    const next = parseMcpListNextCursor(result);
    if (next === undefined) return merged;
    cursor = next;
  }
  throw new McpProtocolError(serverId, `${methodLabel} exceeded ${maxPages} page(s) with a cursor still present`);
}

/**
 * Fetch every page of `tools/list` and merge tool claims (duplicate names on later
 * pages are dropped; same semantics as `parseToolsList` within a page).
 */
export async function listAllMcpTools(
  listPage: (cursor?: string) => Promise<unknown>,
  serverId: string,
  opts: ListAllMcpToolsOptions = {},
): Promise<McpToolInfo[]> {
  return listAllMcpListPages(listPage, parseToolsList, (t) => t.name, serverId, "tools/list", opts);
}

/**
 * Fetch every page of `resources/list` and merge resource claims (duplicate URIs
 * on later pages are dropped).
 */
export async function listAllMcpResources(
  listPage: (cursor?: string) => Promise<unknown>,
  serverId: string,
  opts: ListAllMcpListOptions = {},
): Promise<McpResourceInfo[]> {
  return listAllMcpListPages(listPage, parseResourcesList, (r) => r.uri, serverId, "resources/list", opts);
}

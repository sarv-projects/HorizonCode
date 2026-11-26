/**
 * routing-token.ts -- data-driven sticky routing token (plan Task 1).
 *
 * Identifies an ENDPOINT CONFIGURATION for retry/W→ HTTP affinity. It is not a
 * security boundary, never carries credentials, and never inspects a model id.
 */

import { canonicalJson, sha256Hex } from "../canon";

export interface RoutingEndpoint {
  provider: string;
  baseUrl: string;
  accountLabel?: string;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** 64-hex digest of the routing-relevant fields only. */
export function routingToken(endpoint: RoutingEndpoint): string {
  return sha256Hex(canonicalJson({
    provider: endpoint.provider.toLowerCase(),
    baseUrl: normalizeBaseUrl(endpoint.baseUrl),
    accountLabel: endpoint.accountLabel ?? "",
  }));
}

/** Two endpoints share a route when their tokens match. Model is not input. */
export function sameRoutingRoute(a: RoutingEndpoint, b: RoutingEndpoint): boolean {
  return routingToken(a) === routingToken(b);
}

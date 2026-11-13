/**
 * OAuth access-token refresh (docs/33 §5.6 partial).
 *
 * Store commits bump `oauth-refresh-notify` generation (`store.writeOAuthToken`).
 */

import { homedir } from "node:os";
import type { Credential } from "../../contracts";
import type { ProviderOAuthEndpoints } from "../config";
import { appendOAuthClientAuth } from "./oauth-params";
import { withOAuthRefreshLock } from "./oauth-lock";
import { credentialFromStore, readOAuthToken, writeOAuthToken, type StoredOAuthToken } from "./store";

const pendingByProvider = new Map<string, Promise<Credential | undefined>>();

/** Margin before `expiresAt` when a proactive refresh is worthwhile. */
export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function oauthAccessExpiring(stored: StoredOAuthToken, now = Date.now()): boolean {
  if (!stored.expiresAt) return false;
  const at = Date.parse(stored.expiresAt);
  if (!Number.isFinite(at)) return false;
  return at <= now + OAUTH_REFRESH_MARGIN_MS;
}

async function refreshOAuthAccessTokenLocked(
  provider: string,
  endpoints: ProviderOAuthEndpoints,
  home: string,
  fetcher: typeof fetch,
): Promise<Credential | undefined> {
  return withOAuthRefreshLock(provider, home, async () => {
    const stored = readOAuthToken(provider, home);
    if (!stored?.refreshToken) return undefined;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: endpoints.clientId,
    });
    appendOAuthClientAuth(body, endpoints);
    const res = await fetcher(endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) return undefined;
    let tok: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      tok = (await res.json()) as typeof tok;
    } catch {
      return undefined;
    }
    if (typeof tok.access_token !== "string" || tok.access_token === "") return undefined;
    const latest = readOAuthToken(provider, home);
    if (
      latest &&
      (latest.accessToken !== stored.accessToken || latest.refreshToken !== stored.refreshToken)
    ) {
      return credentialFromStore(provider, home);
    }
    const next: StoredOAuthToken = {
      provider,
      accessToken: tok.access_token,
      obtainedAt: new Date().toISOString(),
      refreshToken: typeof tok.refresh_token === "string" ? tok.refresh_token : stored.refreshToken,
    };
    if (typeof tok.expires_in === "number" && Number.isFinite(tok.expires_in)) {
      next.expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
    } else if (stored.expiresAt) {
      next.expiresAt = stored.expiresAt;
    }
    writeOAuthToken(next, home);
    return credentialFromStore(provider, home);
  });
}

export async function refreshOAuthAccessToken(
  provider: string,
  endpoints: ProviderOAuthEndpoints,
  home: string = homedir(),
  fetcher: typeof fetch = fetch,
): Promise<Credential | undefined> {
  const inFlight = pendingByProvider.get(provider);
  if (inFlight) return inFlight;
  const work = refreshOAuthAccessTokenLocked(provider, endpoints, home, fetcher);
  pendingByProvider.set(provider, work);
  try {
    return await work;
  } finally {
    if (pendingByProvider.get(provider) === work) pendingByProvider.delete(provider);
  }
}

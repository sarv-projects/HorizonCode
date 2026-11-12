/**
 * OAuth access-token refresh (docs/33 §5.6 partial).
 */

import { homedir } from "node:os";
import type { Credential } from "../../contracts";
import type { ProviderOAuthEndpoints } from "../config";
import { credentialFromStore, readOAuthToken, writeOAuthToken, type StoredOAuthToken } from "./store";

export async function refreshOAuthAccessToken(
  provider: string,
  endpoints: ProviderOAuthEndpoints,
  home: string = homedir(),
  fetcher: typeof fetch = fetch,
): Promise<Credential | undefined> {
  const stored = readOAuthToken(provider, home);
  if (!stored?.refreshToken) return undefined;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: endpoints.clientId,
  });
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
}

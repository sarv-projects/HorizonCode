/**
 * OAuth PKCE login/logout (docs/33 §5.6 reduced form).
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import type { ProviderOAuthEndpoints, ProviderRegistryEntry } from "../config";
import { startOAuthCallbackListener } from "./callback-server";
import { createPkcePair, newOAuthState } from "./pkce";
import { oauthTokenPath, writeOAuthToken, type StoredOAuthToken } from "./store";

export function providerHasOAuth(entry: ProviderRegistryEntry): entry is ProviderRegistryEntry & { oauth: ProviderOAuthEndpoints } {
  return entry.oauth !== undefined && entry.oauth.clientId !== "" && entry.oauth.authorizeUrl !== "" && entry.oauth.tokenUrl !== "";
}

export async function runPkceLogin(
  entry: ProviderRegistryEntry & { oauth: ProviderOAuthEndpoints },
  home: string = homedir(),
): Promise<void> {
  const { verifier, challenge, method } = createPkcePair();
  const state = newOAuthState();
  const callbackPath = entry.oauth.callbackPath ?? "/callback";
  const listener = startOAuthCallbackListener({ state, path: callbackPath });

  const authUrl = new URL(entry.oauth.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", entry.oauth.clientId);
  authUrl.searchParams.set("redirect_uri", listener.redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", method);
  if (entry.oauth.scopes?.length) authUrl.searchParams.set("scope", entry.oauth.scopes.join(" "));

  process.stderr.write(`Open this URL to authorize:\n${authUrl.toString()}\nWaiting for callback on ${listener.redirectUri} …\n`);

  const cb = await listener.result;
  if (cb.error) throw new Error(`oauth error: ${cb.error}${cb.errorDescription ? ` — ${cb.errorDescription}` : ""}`);
  if (!cb.code) throw new Error("oauth: no authorization code");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: entry.oauth.clientId,
    code: cb.code,
    redirect_uri: listener.redirectUri,
    code_verifier: verifier,
  });
  const tokenRes = await fetch(entry.oauth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${text.slice(0, 200)}`);
  }
  const tok = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (typeof tok.access_token !== "string" || tok.access_token === "") throw new Error("token response missing access_token");
  const stored: StoredOAuthToken = {
    provider: entry.id,
    accessToken: tok.access_token,
    obtainedAt: new Date().toISOString(),
  };
  if (typeof tok.refresh_token === "string") stored.refreshToken = tok.refresh_token;
  if (typeof tok.expires_in === "number" && Number.isFinite(tok.expires_in)) {
    stored.expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
  }
  writeOAuthToken(stored, home);
  process.stderr.write(`Stored oauth token for ${entry.id} (${oauthTokenPath(entry.id, home)})\n`);
}

export function runOAuthLogout(provider: string, home: string = homedir()): void {
  const file = oauthTokenPath(provider, home);
  try {
    unlinkSync(file);
    process.stderr.write(`Removed ${file}\n`);
  } catch {
    throw new Error(`no oauth token file for ${provider}`);
  }
}

/**
 * Shared OAuth token request fields (PKCE, refresh, device).
 */

import type { ProviderOAuthEndpoints } from "../config";

export function appendOAuthClientAuth(params: URLSearchParams, oauth: ProviderOAuthEndpoints): void {
  if (typeof oauth.clientSecret === "string" && oauth.clientSecret.trim() !== "") {
    params.set("client_secret", oauth.clientSecret.trim());
  }
}

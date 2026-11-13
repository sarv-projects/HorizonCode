import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startOAuthCallbackListener } from "../../src/core/auth/callback-server";
import { runDeviceCodeLogin } from "../../src/core/auth/device";
import { createPkcePair, newOAuthState } from "../../src/core/auth/pkce";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { credentialFromStore, readOAuthToken, writeOAuthToken } from "../../src/core/auth/store";
import type { ProviderRegistryEntry } from "../../src/core/config";
import { startFakeOAuthIdp } from "../fixtures/fake-oauth-idp";

describe("oauth hermetic e2e (fake IdP)", () => {
  let home = "";
  let idp: ReturnType<typeof startFakeOAuthIdp> | undefined;

  afterEach(() => {
    idp?.stop();
    idp = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  function entryFor(id: string): ProviderRegistryEntry & {
    oauth: {
      authorizeUrl: string;
      tokenUrl: string;
      deviceAuthorizationUrl: string;
      clientId: string;
    };
  } {
    return {
      id,
      baseUrl: "https://api.example/v1",
      oauth: {
        clientId: "hermetic-test-client",
        authorizeUrl: `${idp!.baseUrl}/authorize`,
        tokenUrl: `${idp!.baseUrl}/token`,
        deviceAuthorizationUrl: `${idp!.baseUrl}/device`,
      },
    };
  }

  test("device grant, PKCE code exchange, and refresh round-trip", async () => {
    idp = startFakeOAuthIdp();
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-e2e-"));
    const fetcher = idp.fetch;

    const deviceEntry = entryFor("devhost");
    await runDeviceCodeLogin(deviceEntry, { home, fetcher, pollMs: 1, timeoutMs: 10_000 });
    expect(readOAuthToken("devhost", home)?.accessToken.startsWith("device-")).toBe(true);

    const refreshed = await refreshOAuthAccessToken("devhost", deviceEntry.oauth, home, fetcher);
    expect(refreshed?.kind).toBe("oauth");
    if (refreshed?.kind === "oauth") expect(refreshed.accessToken.startsWith("refreshed-")).toBe(true);

    const { verifier, challenge, method } = createPkcePair();
    const state = newOAuthState();
    const listener = startOAuthCallbackListener({ state, path: "/cb", timeoutMs: 8000 });
    const auth = new URL(deviceEntry.oauth.authorizeUrl);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", deviceEntry.oauth.clientId);
    auth.searchParams.set("redirect_uri", listener.redirectUri);
    auth.searchParams.set("state", state);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", method);
    await fetcher(auth.toString());
    const cb = await listener.result;
    listener.stop();
    expect(cb.code).toBeTruthy();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: deviceEntry.oauth.clientId,
      code: cb.code!,
      redirect_uri: listener.redirectUri,
      code_verifier: verifier,
    });
    const tokenRes = await fetcher(deviceEntry.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    expect(tokenRes.ok).toBe(true);
    const tok = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    writeOAuthToken(
      {
        provider: "pkcehost",
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    expect(credentialFromStore("pkcehost", home)?.kind).toBe("oauth");
    expect(tok.access_token.startsWith("pkce-")).toBe(true);
  }, 20_000);
});

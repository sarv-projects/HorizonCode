import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { writeOAuthToken } from "../../src/core/auth/store";

describe("oauth refresh", () => {
  let home = "";
  let fetchCalls = 0;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    fetchCalls = 0;
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;
  const endpoints = {
    clientId: "cid",
    authorizeUrl: "https://idp.example/authorize",
    tokenUrl: "https://idp.example/token",
  };

  test("refresh updates the store and returns oauth credential", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-refresh-"));
    writeOAuthToken(
      {
        provider: "myhost",
        accessToken: "stale",
        refreshToken: "rtok",
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    globalThis.fetch = (async (url, init) => {
      fetchCalls += 1;
      expect(String(url)).toBe(endpoints.tokenUrl);
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "rtok2", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const cred = await refreshOAuthAccessToken("myhost", endpoints, home);
    expect(fetchCalls).toBe(1);
    expect(cred).toEqual({
      kind: "oauth",
      accessToken: "fresh",
      refreshToken: "rtok2",
      expiresAt: cred?.kind === "oauth" ? cred.expiresAt : undefined,
    });
    expect(cred?.kind === "oauth" && cred.expiresAt).toBeTruthy();
  });

  test("missing refresh token is a no-op", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-refresh-"));
    writeOAuthToken({ provider: "myhost", accessToken: "only", obtainedAt: new Date().toISOString() }, home);
    globalThis.fetch = (async () => {
      throw new Error("fetch should not run");
    }) as typeof fetch;
    const cred = await refreshOAuthAccessToken("myhost", endpoints, home);
    expect(cred).toBeUndefined();
  });
});

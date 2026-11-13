import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { writeOAuthToken } from "../../src/core/auth/store";

describe("oauth refresh flock", () => {
  let home = "";
  const endpoints = {
    clientId: "cid",
    authorizeUrl: "https://idp.example/authorize",
    tokenUrl: "https://idp.example/token",
  };

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;

  test("concurrent refresh performs one token fetch", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-lock-"));
    writeOAuthToken(
      {
        provider: "host",
        accessToken: "stale",
        refreshToken: "rtok",
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    let tokenCalls = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/token")) {
        tokenCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return new Response(JSON.stringify({ access_token: `fresh-${tokenCalls}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      refreshOAuthAccessToken("host", endpoints, home),
      refreshOAuthAccessToken("host", endpoints, home),
    ]);
    expect(tokenCalls).toBe(1);
    expect(a?.kind).toBe("oauth");
    expect(b?.kind).toBe("oauth");
    if (a?.kind === "oauth" && b?.kind === "oauth") expect(a.accessToken).toBe(b.accessToken);
  });
});

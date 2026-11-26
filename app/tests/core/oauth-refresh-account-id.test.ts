/**
 * oauth-refresh-account-id.test.ts — refresh preserves provider/account identity.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeOAuthToken, readOAuthToken } from "../../src/core/auth/store";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";

test("refresh keeps the stored account id", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-aid-"));
  try {
    await writeOAuthToken(
      { provider: "demo", accessToken: "old", refreshToken: "r1", obtainedAt: new Date().toISOString(), accountId: "acct-42" },
      home,
    );
    const fetcher = (async () =>
      new Response(JSON.stringify({ access_token: "new", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const credential = await refreshOAuthAccessToken(
      "demo",
      { clientId: "cid", authorizeUrl: "https://a.example/auth", tokenUrl: "https://a.example/token" },
      home,
      fetcher,
    );
    expect(credential).toBeDefined();
    const stored = readOAuthToken("demo", home);
    expect(stored?.accessToken).toBe("new");
    expect(stored?.accountId).toBe("acct-42");
  } finally {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* windows handle */
    }
  }
});

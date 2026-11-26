/**
 * oauth-refresh-account-switch.test.ts — refresh cannot silently rotate a pinned OAuth identity.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { readOAuthToken, writeOAuthToken } from "../../src/core/auth/store";

function jwt(payload: object): string {
  return ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

test("refresh leaves the stored credential untouched when account identity changes", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-switch-"));
  try {
    await writeOAuthToken({ provider: "demo", accessToken: jwt({ account_id: "acct-42" }), refreshToken: "r1", obtainedAt: new Date().toISOString(), accountId: "acct-42" }, home);
    const fetcher = (async () => new Response(JSON.stringify({ access_token: jwt({ account_id: "acct-99" }), refresh_token: "r2" }), { status: 200 })) as typeof fetch;
    const result = await refreshOAuthAccessToken(
      "demo",
      { clientId: "cid", authorizeUrl: "https://a.example/auth", tokenUrl: "https://a.example/token" },
      home,
      fetcher,
    );
    expect(result).toBeUndefined();
    const stored = readOAuthToken("demo", home);
    expect(stored?.accountId).toBe("acct-42");
    expect(stored?.refreshToken).toBe("r1");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows SQLite cleanup */ }
  }
});

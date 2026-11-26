/**
 * oauth-device-account-id.test.ts — device OAuth captures stable account claims from JWT access tokens.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runDeviceCodeLogin } from "../../src/core/auth/device";
import { readOAuthToken } from "../../src/core/auth/store";

function jwt(payload: object): string {
  return ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

test("device login stores provider account identity extracted from access token", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "hz-device-account-"));
  try {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/device")) {
        return new Response(JSON.stringify({ device_code: "dc", interval: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: jwt({ user_id: "user-7", "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" } }), expires_in: 60 }), { status: 200 });
    }) as typeof fetch;
    await runDeviceCodeLogin(
      { id: "demo", baseUrl: "https://api.example/v1", protocol: "openai-chat", oauth: { authorizeUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "cid", deviceAuthorizationUrl: "https://auth.example/device" } },
      { home, pollMs: 0, timeoutMs: 1000, fetcher },
    );
    expect(readOAuthToken("demo", home)?.accountId).toBe("acct-42");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows SQLite cleanup */ }
  }
});

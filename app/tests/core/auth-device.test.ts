import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runDeviceCodeLogin } from "../../src/core/auth/device";
import { credentialFromStore } from "../../src/core/auth/store";

describe("oauth device flow", () => {
  let home = "";
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    globalThis.fetch = originalFetch;
  });

  test("polls until access_token", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-device-"));
    let polls = 0;
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.includes("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dcode",
            user_code: "ABCD-1234",
            verification_uri: "https://example/verify",
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      polls += 1;
      if (polls < 2) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "dev-tok", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const fetcher = globalThis.fetch;
    await runDeviceCodeLogin(
      {
        id: "demo",
        baseUrl: "https://api.example/v1",
        protocol: "openai-chat",
        oauth: {
          authorizeUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
          clientId: "cid",
          deviceAuthorizationUrl: "https://auth.example/device",
        },
      },
      { home, timeoutMs: 30_000, fetcher },
    );

    expect(polls).toBe(2);
    const cred = credentialFromStore("demo", home);
    expect(cred?.kind).toBe("oauth");
    if (cred?.kind === "oauth") expect(cred.accessToken).toBe("dev-tok");
  });
});

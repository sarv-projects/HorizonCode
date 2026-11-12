import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createPkcePair } from "../../src/core/auth/pkce";
import { startOAuthCallbackListener } from "../../src/core/auth/callback-server";
import { parseProviderEntry } from "../../src/core/config";

describe("PKCE", () => {
  test("challenge is S256 of verifier", () => {
    const { verifier, challenge, method } = createPkcePair();
    expect(method).toBe("S256");
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(challenge).toBe(expected);
  });

  test("parseProviderEntry accepts oauth block", () => {
    const parsed = parseProviderEntry(
      {
        id: "demo",
        baseUrl: "https://api.example/v1",
        oauth: {
          authorizeUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
          clientId: "cid",
          scopes: ["openid"],
        },
      },
      0,
    );
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    expect(parsed.oauth?.clientId).toBe("cid");
  });

  test("callback listener accepts matching state", async () => {
    const state = "st";
    const listener = startOAuthCallbackListener({ state, path: "/cb", timeoutMs: 5000 });
    const res = await fetch(`${listener.redirectUri}?code=abc&state=${state}`);
    expect(res.ok).toBe(true);
    const out = await listener.result;
    expect(out.code).toBe("abc");
    listener.stop();
  });
});

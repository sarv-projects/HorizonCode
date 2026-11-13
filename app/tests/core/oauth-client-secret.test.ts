import { describe, expect, test } from "bun:test";
import { appendOAuthClientAuth } from "../../src/core/auth/oauth-params";

describe("oauth client_secret_post", () => {
  test("appends client_secret when configured", () => {
    const params = new URLSearchParams({ grant_type: "refresh_token" });
    appendOAuthClientAuth(params, {
      authorizeUrl: "https://x/a",
      tokenUrl: "https://x/t",
      clientId: "id",
      clientSecret: "sekret",
    });
    expect(params.get("client_secret")).toBe("sekret");
  });

  test("omits client_secret when absent", () => {
    const params = new URLSearchParams();
    appendOAuthClientAuth(params, { authorizeUrl: "a", tokenUrl: "t", clientId: "id" });
    expect(params.has("client_secret")).toBe(false);
  });
});

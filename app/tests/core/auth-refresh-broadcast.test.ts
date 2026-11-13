import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
import {
  bumpOAuthRefreshGeneration,
  oauthRefreshNotifyPath,
  readOAuthRefreshGeneration,
} from "../../src/core/auth/oauth-refresh-notify";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { OAuthCredentialHandle, writeOAuthToken } from "../../src/core/auth/store";

describe("oauth refresh cross-process broadcast", () => {
  let home = "";
  let workspace = "";
  const endpoints = {
    clientId: "cid",
    authorizeUrl: "https://idp.example/authorize",
    tokenUrl: "https://idp.example/token",
  };

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    home = "";
    workspace = "";
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;

  test("writeOAuthToken bumps generation notify file", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    expect(readOAuthRefreshGeneration("p", home)).toBe(0);
    writeOAuthToken(
      { provider: "p", accessToken: "a1", obtainedAt: new Date().toISOString() },
      home,
    );
    expect(readOAuthRefreshGeneration("p", home)).toBe(1);
    writeOAuthToken(
      { provider: "p", accessToken: "a2", obtainedAt: new Date().toISOString() },
      home,
    );
    expect(readOAuthRefreshGeneration("p", home)).toBe(2);
    expect(oauthRefreshNotifyPath("p", home)).toContain(".refresh.gen");
  });

  test("two store handles on shared home observe refresh via generation poll", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    workspace = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-ws-"));
    const kernelA = new KernelClient({ workspace });
    const kernelB = new KernelClient({ workspace });
    expect(kernelA).toBeDefined();
    expect(kernelB).toBeDefined();

    writeOAuthToken(
      {
        provider: "host",
        accessToken: "stale",
        refreshToken: "rtok",
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    const handleA = new OAuthCredentialHandle("host", home);
    const handleB = new OAuthCredentialHandle("host", home);
    const initial = handleA.pollCredential();
    expect(initial?.kind).toBe("oauth");
    if (initial?.kind === "oauth") expect(initial.accessToken).toBe("stale");
    handleB.bindCredential(initial);

    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-shared" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const refreshed = await refreshOAuthAccessToken("host", endpoints, home);
    expect(refreshed?.kind).toBe("oauth");
    if (refreshed?.kind === "oauth") expect(refreshed.accessToken).toBe("fresh-shared");
    expect(readOAuthRefreshGeneration("host", home)).toBeGreaterThan(0);

    const stillStale = handleB.pollCredential();
    expect(stillStale?.kind).toBe("oauth");
    if (stillStale?.kind === "oauth") expect(stillStale.accessToken).toBe("fresh-shared");

    handleA.bindCredential(refreshed);
    const viaA = handleA.pollCredential();
    if (viaA?.kind === "oauth") expect(viaA.accessToken).toBe("fresh-shared");
  });

  test("bumpOAuthRefreshGeneration is monotonic", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    expect(bumpOAuthRefreshGeneration("x", home)).toBe(1);
    expect(bumpOAuthRefreshGeneration("x", home)).toBe(2);
    expect(readOAuthRefreshGeneration("x", home)).toBe(2);
  });
});

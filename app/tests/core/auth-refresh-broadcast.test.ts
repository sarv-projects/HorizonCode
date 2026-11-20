import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
import {
  admitOAuthRefreshNotifyWrite, bumpOAuthRefreshGeneration,
  oauthRefreshNotifyPath,
  readOAuthRefreshGeneration,
} from "../../src/core/auth/oauth-refresh-notify";
import { onOAuthAccountRotated, refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { OAuthCredentialHandle, writeOAuthToken } from "../../src/core/auth/store";
import { EventTypes } from "../../src/contracts";
import { createRuntime } from "../../src/core";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import { readFileSync } from "node:fs";

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

  test("writeOAuthToken bumps generation notify file", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    expect(readOAuthRefreshGeneration("p", home)).toBe(0);
    await writeOAuthToken(
      { provider: "p", accessToken: "a1", obtainedAt: new Date().toISOString() },
      home,
    );
    expect(readOAuthRefreshGeneration("p", home)).toBe(1);
    await writeOAuthToken(
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

    await writeOAuthToken(
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

  test("successful refresh notifies OAuth account-rotated listeners (449)", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    await writeOAuthToken(
      {
        provider: "host",
        accessToken: "stale",
        refreshToken: "rtok",
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    const seen: Array<{ providerId: string; reason: string }> = [];
    const stop = onOAuthAccountRotated((info) => seen.push(info));
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "fresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      await refreshOAuthAccessToken("host", endpoints, home);
      expect(seen).toEqual([{ providerId: "host", reason: "retryable_failures" }]);
    } finally {
      stop();
    }
  });

  test("Runtime appends hz.provider.account.rotated on OAuth refresh (449)", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    workspace = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-ws-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    await writeOAuthToken(
      {
        provider: "host",
        accessToken: "stale",
        refreshToken: "rtok",
        obtainedAt: new Date().toISOString(),
      },
      home,
    );
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-rt" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      await refreshOAuthAccessToken("host", endpoints, home);
      await new Promise((r) => setTimeout(r, 50));
      const file = sessionEventsPath(workspace, runtime.sessionId);
      const rows = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
      const rotated = rows.filter((row) => row.type === EventTypes.providerAccountRotated);
      expect(rotated.length).toBeGreaterThanOrEqual(1);
      expect(rotated[0]?.payload?.providerId).toBe("host");
      expect(rotated[0]?.payload?.reason).toBe("retryable_failures");
      expect(rotated[0]?.payload?.toAccountRef).toBe("oauth:refreshed");
    } finally {
      await runtime.close();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test("bumpOAuthRefreshGeneration is monotonic", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-bcast-"));
    expect(await bumpOAuthRefreshGeneration("x", home)).toBe(1);
    expect(await bumpOAuthRefreshGeneration("x", home)).toBe(2);
    expect(readOAuthRefreshGeneration("x", home)).toBe(2);
  });

  test("admitOAuthRefreshNotifyWrite refuses deny before bump (ruling 596)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(home, "no-such-hz-kernel");
    try {
      const kernelState = path.join(home, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-oauth-gen" }]),
        "utf8",
      );
      const refused = await admitOAuthRefreshNotifyWrite("x", home);
      expect(refused).toMatch(/denied|test-deny-oauth-gen|oauth-refresh-notify/i);
      expect(await bumpOAuthRefreshGeneration("x", home)).toBeUndefined();
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

});

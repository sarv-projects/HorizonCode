/**
 * Hermetic OAuth IdP stub (PKCE code exchange, device grant, refresh).
 * Test-only — no real client secrets; uses fixed in-memory codes.
 */

import { createHash } from "node:crypto";
import type { Server } from "bun";

export interface FakeOAuthIdp {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  stop(): void;
}

type PendingDevice = { deviceCode: string; interval: number; approved: boolean };

export function startFakeOAuthIdp(): FakeOAuthIdp {
  const verifiers = new Map<string, string>();
  const devices = new Map<string, PendingDevice>();
  let deviceSeq = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/authorize" && req.method === "GET") {
        const redirect = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        if (!redirect) return new Response("missing redirect_uri", { status: 400 });
        const code = `code-${verifiers.size + 1}`;
        verifiers.set(code, challenge);
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", state);
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/device" && req.method === "POST") {
        deviceSeq += 1;
        const deviceCode = `dev-${deviceSeq}`;
        const userCode = `USER-${deviceSeq}`;
        devices.set(deviceCode, { deviceCode, interval: 0, approved: true });
        return Response.json({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${url.origin}/verify`,
          interval: 0,
        });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await req.text();
        const params = new URLSearchParams(body);
        const grant = params.get("grant_type") ?? "";
        if (grant === "authorization_code") {
          const code = params.get("code") ?? "";
          const verifier = params.get("code_verifier") ?? "";
          const challenge = verifiers.get(code);
          if (!challenge) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          const expected = createHash("sha256")
            .update(verifier)
            .digest("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
          if (expected !== challenge) {
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          }
          return Response.json({
            access_token: `pkce-${code}`,
            refresh_token: `pkce-rt-${code}`,
            expires_in: 3600,
          });
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          const deviceCode = params.get("device_code") ?? "";
          const entry = devices.get(deviceCode);
          if (!entry) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          if (!entry.approved) {
            return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
          }
          return Response.json({
            access_token: `device-${deviceCode}`,
            refresh_token: `device-rt-${deviceCode}`,
            expires_in: 7200,
          });
        }
        if (grant === "refresh_token") {
          const rt = params.get("refresh_token") ?? "";
          if (rt === "") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          return Response.json({
            access_token: `refreshed-${rt}`,
            refresh_token: rt,
            expires_in: 3600,
          });
        }
        return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  }) as Server;

  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl,
    fetch: ((input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const local = href.replace(/^https?:\/\/[^/]+/, baseUrl);
      return fetch(local, init);
    }) as typeof fetch,
    stop: () => server.stop(),
  };
}

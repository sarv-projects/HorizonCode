/**
 * OAuth 2.0 device authorization grant (docs/33 §5.6 partial).
 */

import { homedir } from "node:os";
import type { ProviderOAuthEndpoints, ProviderRegistryEntry } from "../config";
import { appendOAuthClientAuth } from "./oauth-params";
import { writeOAuthToken, type StoredOAuthToken } from "./store";

export type DeviceOAuthEndpoints = ProviderOAuthEndpoints & { deviceAuthorizationUrl: string };

export function providerHasDeviceOAuth(
  entry: ProviderRegistryEntry,
): entry is ProviderRegistryEntry & { oauth: DeviceOAuthEndpoints } {
  const o = entry.oauth;
  return (
    o !== undefined &&
    o.clientId !== "" &&
    o.tokenUrl !== "" &&
    typeof o.deviceAuthorizationUrl === "string" &&
    o.deviceAuthorizationUrl !== ""
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function runDeviceCodeLogin(
  entry: ProviderRegistryEntry & { oauth: DeviceOAuthEndpoints },
  opts: { home?: string; pollMs?: number; timeoutMs?: number; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<void> {
  const home = opts.home ?? homedir();
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const started = Date.now();

  const body = new URLSearchParams({ client_id: entry.oauth.clientId });
  appendOAuthClientAuth(body, entry.oauth);
  if (entry.oauth.scopes?.length) body.set("scope", entry.oauth.scopes.join(" "));

  const devRes = await fetcher(entry.oauth.deviceAuthorizationUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: opts.signal,
  });
  if (!devRes.ok) {
    const text = await devRes.text();
    throw new Error(`device authorization failed: HTTP ${devRes.status} ${text.slice(0, 200)}`);
  }
  const dev = (await devRes.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
  };
  if (typeof dev.device_code !== "string" || dev.device_code === "") throw new Error("device response missing device_code");
  const uri = dev.verification_uri_complete ?? dev.verification_uri ?? "";
  const userCode = dev.user_code ?? "";
  process.stderr.write(
    `Authorize this device:\n${uri !== "" ? uri + "\n" : ""}${userCode !== "" ? `code: ${userCode}\n` : ""}Polling for token …\n`,
  );

  let intervalSec =
    typeof dev.interval === "number" && Number.isFinite(dev.interval) && dev.interval >= 0 ? dev.interval : 5;

  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new Error("aborted");
    await sleep(intervalSec * 1000, opts.signal);

    const poll = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: dev.device_code,
      client_id: entry.oauth.clientId,
    });
    appendOAuthClientAuth(poll, entry.oauth);
    const tokRes = await fetcher(entry.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: poll.toString(),
      signal: opts.signal,
    });
    const raw = await tokRes.text();
    let json: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      interval?: number;
    };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new Error(`token poll invalid JSON: ${raw.slice(0, 120)}`);
    }

    if (tokRes.ok && typeof json.access_token === "string" && json.access_token !== "") {
      const stored: StoredOAuthToken = {
        provider: entry.id,
        accessToken: json.access_token,
        obtainedAt: new Date().toISOString(),
      };
      if (typeof json.refresh_token === "string") stored.refreshToken = json.refresh_token;
      if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in)) {
        stored.expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
      }
      writeOAuthToken(stored, home);
      process.stderr.write(`Stored oauth token for ${entry.id}\n`);
      return;
    }

    const err = json.error ?? "";
    if (err === "authorization_pending" || err === "slow_down") {
      if (typeof json.interval === "number" && json.interval > 0) intervalSec = json.interval;
      if (err === "slow_down") intervalSec += 5;
      continue;
    }
    if (err === "access_denied") throw new Error("device authorization denied by user");
    if (err === "expired_token") throw new Error("device code expired");
    throw new Error(`device token poll failed: ${err || `HTTP ${tokRes.status}`}`);
  }
  throw new Error("device authorization timed out");
}

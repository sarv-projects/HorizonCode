/**
 * auth/store.ts — OAuth token storage (docs/33 §5.6 reduced v1).
 *
 * Tokens live only under the user config dir, mode 0600, never logged.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Credential } from "../../contracts";
import { canonicalJson } from "../canon";
import { userConfigDir } from "../paths";

export interface StoredOAuthToken {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  obtainedAt: string;
}

export function oauthTokenPath(provider: string, home: string = homedir()): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(userConfigDir(home), "oauth", `${safe}.json`);
}

export function writeOAuthToken(token: StoredOAuthToken, home: string = homedir()): void {
  const file = oauthTokenPath(token.provider, home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  writeFileSync(tmp, canonicalJson(token) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* */
  }
}

export function readOAuthToken(provider: string, home: string = homedir()): StoredOAuthToken | undefined {
  const file = oauthTokenPath(provider, home);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as StoredOAuthToken;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken === "") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function credentialFromStore(provider: string, home: string = homedir()): Credential | undefined {
  const tok = readOAuthToken(provider, home);
  if (!tok) return undefined;
  return {
    kind: "oauth",
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresAt,
  };
}

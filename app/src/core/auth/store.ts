/**
 * auth/store.ts — OAuth token storage (docs/33 §5.6 reduced v1).
 *
 * Tokens live in user-config SQLite (`credentials.db`, mode 0600) with legacy
 * JSON import; refresh serialization uses `oauth-lock.ts` (OpenCode flock ADAPT);
 * cross-process revision broadcast uses `oauth-refresh-notify.ts`.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Credential } from "../../contracts";
import { userConfigDir } from "../paths";
import {
  deleteOAuthTokenDb,
  migrateLegacyOAuthJsonFiles,
  oauthCredentialsDbPath,
  readOAuthTokenDb,
  writeOAuthTokenDb,
  type StoredOAuthToken,
} from "./credential-db";
import { bumpOAuthRefreshGeneration, readOAuthRefreshGeneration } from "./oauth-refresh-notify";

export type { StoredOAuthToken };

/** Legacy per-provider JSON path (import source only after SQLite store). */
export function oauthTokenPath(provider: string, home: string = homedir()): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(userConfigDir(home), "oauth", `${safe}.json`);
}

export function credentialsDbPath(home: string = homedir()): string {
  return oauthCredentialsDbPath(home);
}

export function writeOAuthToken(token: StoredOAuthToken, home: string = homedir()): void {
  const legacyDir = path.dirname(oauthTokenPath(token.provider, home));
  if (!existsSync(legacyDir)) mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  writeOAuthTokenDb(token, home);
  bumpOAuthRefreshGeneration(token.provider, home);
  try {
    unlinkSync(oauthTokenPath(token.provider, home));
  } catch {
    /* migrated away from flat files */
  }
  try {
    chmodSync(oauthCredentialsDbPath(home), 0o600);
  } catch {
    /* */
  }
}

export function readOAuthToken(provider: string, home: string = homedir()): StoredOAuthToken | undefined {
  migrateLegacyOAuthJsonFiles(home);
  return readOAuthTokenDb(provider, home);
}

export function deleteOAuthToken(provider: string, home: string = homedir()): boolean {
  const removed = deleteOAuthTokenDb(provider, home);
  try {
    unlinkSync(oauthTokenPath(provider, home));
  } catch {
    /* */
  }
  return removed;
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

/**
 * In-process OAuth credential cache keyed off `oauth-refresh-notify` generation.
 * Models a second hzcode process polling the store after another refreshes.
 */
export class OAuthCredentialHandle {
  private lastGeneration = -1;
  private cached: Credential | undefined;

  constructor(
    readonly provider: string,
    readonly home: string = homedir(),
  ) {}

  bindCredential(credential: Credential | undefined): void {
    this.cached = credential;
    this.lastGeneration = readOAuthRefreshGeneration(this.provider, this.home);
  }

  /** Reload from SQLite when another process bumped the refresh generation. */
  pollCredential(): Credential | undefined {
    const gen = readOAuthRefreshGeneration(this.provider, this.home);
    if (gen !== this.lastGeneration) {
      this.lastGeneration = gen;
      this.cached = credentialFromStore(this.provider, this.home);
    }
    return this.cached;
  }
}

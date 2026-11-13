/**
 * credential-db.ts — SQLite credential store (ADAPT OpenCode credential/sql.ts).
 *
 * OAuth tokens live in the user config dir; the db file is mode 0600.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { canonicalJson } from "../canon";
import { withFileLockSync } from "../file-lock";
import { userConfigDir } from "../paths";
export interface StoredOAuthToken {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  obtainedAt: string;
}

const SCHEMA_VERSION = 1;

export function oauthCredentialsDbPath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "credentials.db");
}

export function oauthCredentialsLockPath(home: string = homedir()): string {
  return path.join(userConfigDir(home), "credentials.db.lock");
}

function ensureDbMode0600(dbPath: string): void {
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* best effort */
  }
}

function ensureSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const row = db.query(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | null;
  if (row === null) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_token (
      provider TEXT PRIMARY KEY NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      obtained_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function openCredentialsDb(home: string): Database {
  const dbPath = oauthCredentialsDbPath(home);
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { create: true });
  ensureSchema(db);
  ensureDbMode0600(dbPath);
  return db;
}

function rowToToken(row: {
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  obtained_at: string;
}): StoredOAuthToken {
  const tok: StoredOAuthToken = {
    provider: row.provider,
    accessToken: row.access_token,
    obtainedAt: row.obtained_at,
  };
  if (row.refresh_token) tok.refreshToken = row.refresh_token;
  if (row.expires_at) tok.expiresAt = row.expires_at;
  return tok;
}

function legacyOauthDir(home: string): string {
  return path.join(userConfigDir(home), "oauth");
}

/** Import flat `oauth/<provider>.json` files when the row is absent. */
export function migrateLegacyOAuthJsonFiles(home: string): number {
  const dir = legacyOauthDir(home);
  if (!existsSync(dir)) return 0;
  let imported = 0;
  withFileLockSync(oauthCredentialsLockPath(home), () => {
    const db = openCredentialsDb(home);
    try {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO oauth_token(
          provider, access_token, refresh_token, expires_at, obtained_at, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
        const provider = name.slice(0, -".json".length);
        if (provider === "") continue;
        const exists = db.query(`SELECT 1 FROM oauth_token WHERE provider=?`).get(provider);
        if (exists) continue;
        try {
          const raw = readFileSync(path.join(dir, name), "utf8");
          const parsed = JSON.parse(raw) as StoredOAuthToken;
          if (typeof parsed.accessToken !== "string" || parsed.accessToken === "") continue;
          const now = new Date().toISOString();
          const payload = canonicalJson({
            provider: parsed.provider || provider,
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            expiresAt: parsed.expiresAt,
            obtainedAt: parsed.obtainedAt || now,
          });
          insert.run(
            parsed.provider || provider,
            parsed.accessToken,
            parsed.refreshToken ?? null,
            parsed.expiresAt ?? null,
            parsed.obtainedAt || now,
            payload,
            now,
          );
          imported += 1;
        } catch {
          /* corrupt legacy file — skip */
        }
      }
    } finally {
      db.close();
      ensureDbMode0600(oauthCredentialsDbPath(home));
    }
  });
  return imported;
}

export function readOAuthTokenDb(provider: string, home: string): StoredOAuthToken | undefined {
  migrateLegacyOAuthJsonFiles(home);
  return withFileLockSync(oauthCredentialsLockPath(home), () => {
    const db = openCredentialsDb(home);
    try {
      const row = db
        .query(
          `SELECT provider, access_token, refresh_token, expires_at, obtained_at
           FROM oauth_token WHERE provider=?`,
        )
        .get(provider) as
        | {
            provider: string;
            access_token: string;
            refresh_token: string | null;
            expires_at: string | null;
            obtained_at: string;
          }
        | null;
      if (row === null) return undefined;
      return rowToToken(row);
    } finally {
      db.close();
    }
  });
}

export function writeOAuthTokenDb(token: StoredOAuthToken, home: string): void {
  withFileLockSync(oauthCredentialsLockPath(home), () => {
    const db = openCredentialsDb(home);
    try {
      const now = new Date().toISOString();
      const payload = canonicalJson({
        provider: token.provider,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        obtainedAt: token.obtainedAt,
      });
      db.prepare(
        `INSERT INTO oauth_token(
          provider, access_token, refresh_token, expires_at, obtained_at, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          access_token=excluded.access_token,
          refresh_token=excluded.refresh_token,
          expires_at=excluded.expires_at,
          obtained_at=excluded.obtained_at,
          payload=excluded.payload,
          updated_at=excluded.updated_at`,
      ).run(
        token.provider,
        token.accessToken,
        token.refreshToken ?? null,
        token.expiresAt ?? null,
        token.obtainedAt,
        payload,
        now,
      );
    } finally {
      db.close();
      ensureDbMode0600(oauthCredentialsDbPath(home));
    }
  });
}

export function deleteOAuthTokenDb(provider: string, home: string): boolean {
  return withFileLockSync(oauthCredentialsLockPath(home), () => {
    const db = openCredentialsDb(home);
    try {
      const info = db.prepare(`DELETE FROM oauth_token WHERE provider=?`).run(provider);
      return info.changes > 0;
    } finally {
      db.close();
    }
  });
}

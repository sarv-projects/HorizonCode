/**
 * oauth-refresh-notify.ts — cross-process OAuth store revision broadcast.
 *
 * ADAPT `oauth-lock.ts` flock pairing: after SQLite commits a token revision,
 * bump a per-provider generation counter (`oauth/<provider>.refresh.gen`, mode
 * 0600) so other hzcode processes can poll and reload without polling SQLite.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { userConfigDir } from "../paths";

export function oauthRefreshNotifyPath(provider: string, home: string = homedir()): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(userConfigDir(home), "oauth", `${safe}.refresh.gen`);
}

export function readOAuthRefreshGeneration(provider: string, home: string = homedir()): number {
  try {
    const raw = readFileSync(oauthRefreshNotifyPath(provider, home), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Atomically bump and return the new generation (starts at 1 on first write). */
export function bumpOAuthRefreshGeneration(provider: string, home: string = homedir()): number {
  const file = oauthRefreshNotifyPath(provider, home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = readOAuthRefreshGeneration(provider, home) + 1;
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

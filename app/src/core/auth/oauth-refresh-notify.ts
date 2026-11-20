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

/**
 * Under-admission (ruling 596): Guard `fs.write` on the refresh.gen path before
 * bump. `home` is the admit root.
 */
export async function admitOAuthRefreshNotifyWrite(
  provider: string,
  home: string = homedir(),
): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("../preds-writer");
  const refused = await admitPredsOutWrite(oauthRefreshNotifyPath(provider, home), home);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "oauth-refresh-notify refused:")
    .replace(/^preds write denied/, "oauth-refresh-notify denied")
    .replace(/^preds fs\.write requires approval/, "oauth-refresh-notify fs.write requires approval");
}

/** Atomically bump and return the new generation (starts at 1 on first write). */
export async function bumpOAuthRefreshGeneration(
  provider: string,
  home: string = homedir(),
): Promise<number | undefined> {
  const refused = await admitOAuthRefreshNotifyWrite(provider, home);
  if (refused !== undefined) return undefined;
  const file = oauthRefreshNotifyPath(provider, home);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = readOAuthRefreshGeneration(provider, home) + 1;
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

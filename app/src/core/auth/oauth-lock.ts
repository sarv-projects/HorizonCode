/**
 * oauth-lock.ts — cross-process refresh serialization (ADAPT OpenCode Credential flock).
 *
 * Pair with `oauth-refresh-notify.ts`: the holder bumps `*.refresh.gen` after SQLite
 * commits so other processes can poll instead of racing another refresh.
 */

import * as path from "node:path";
import { withFileLock } from "../file-lock";
import { userConfigDir } from "../paths";

export function oauthRefreshLockPath(provider: string, home: string): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(userConfigDir(home), "oauth", `${safe}.refresh.lock`);
}

export async function withOAuthRefreshLock<T>(
  provider: string,
  home: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(oauthRefreshLockPath(provider, home), fn, { timeoutMs: 30_000 });
}

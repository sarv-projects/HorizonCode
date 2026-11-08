/** Shared helpers for the HorizonCode tool set. */

import path from "node:path";

/** Truncate text to `max` characters, appending an explicit marker when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "\n[truncated]";
}

/** Resolve a caller-supplied path against the tool context cwd. */
export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/** True when a NUL byte appears in the head of the buffer (binary file). */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Display path: relative to `base` when inside it, absolute otherwise. */
export function relPath(base: string, p: string): string {
  const rel = path.relative(base, p);
  if (rel === "") return path.basename(p) || ".";
  // `..notes.md` is a normal file name; only a real `..` step (or another
  // absolute path) means the target is outside the base.
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? p : rel;
}

/** Environment names that must never reach a child process. */
const SECRET_ENV = /(key|token|secret|password)$/i;
/**
 * Names that are credentials by convention even though the suffix rule misses
 * them: `*_DSN`, `*_CREDENTIALS`, `*_PASS`, `*_PWD`, `*_CONNECTION_STRING`
 * (audit finding 17).
 */
const SECRET_ENV_NAME = /(_dsn|_credentials|_pass|_passwd|_pwd|connection_string)$/i;
/**
 * A URL whose authority carries credentials: `scheme://user:password@host`.
 * This catches `DATABASE_URL`, `REDIS_URL` and friends WITHOUT dropping
 * credential-free URLs a build tool legitimately needs (`PIP_INDEX_URL`).
 */
const CREDENTIAL_IN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]*@/i;

/**
 * Inherit the environment, minus anything that looks like a credential.
 * Every tool that spawns a child process (shell, code_mode, preview) must use
 * this, so one code path cannot silently leak what another one scrubs.
 *
 * Three rules, because a suffix deny-list alone leaked the common modern
 * shapes: the name rule, the credential-name rule above, and the value rule
 * for connection strings.
 */
export function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SECRET_ENV.test(k) || SECRET_ENV_NAME.test(k) || CREDENTIAL_IN_URL.test(v)) continue;
    env[k] = v;
  }
  // NF-074 / docs/09 §2.10 item 3: env-taming defaults for the child — the
  // human's own value always wins when one is set.
  for (const [k, v] of Object.entries(TAMING_ENV_DEFAULTS)) {
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

/** Non-interactive defaults for spawned shells (PAGER family, progress bars). */
export const TAMING_ENV_DEFAULTS: Record<string, string> = {
  PAGER: "cat",
  MANPAGER: "cat",
  GIT_PAGER: "cat",
  LESS: "-R",
  TQDM_DISABLE: "1",
  PIP_PROGRESS_BAR: "off",
};

/** Shared helpers for the HorizonCode tool set. */

import path from "node:path";
import { realpathish } from "../core/paths";

/** Truncate text to `max` characters, appending an explicit marker when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "\n[truncated]";
}

/** Resolve a caller-supplied path against the tool context cwd. */
export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/**
 * A path as requested, where it really lands, and whether that real target is
 * inside the workspace. `real` follows symlinks through the deepest existing
 * ancestor (`realpathish`), so a new file under a symlinked directory resolves
 * to the directory the bytes would actually land in, and an existing file
 * resolves through its own link. Tools MUST guard `real`, never `requested`:
 * the policy decides on the path whose bytes the effect touches.
 */
export interface RealTarget {
  /** The lexical absolute path the caller asked for. */
  requested: string;
  /** Where the target really is (symlinks followed; new files through their parent). */
  real: string;
  /** True when `real` is the workspace root or inside it, after resolution. */
  inside: boolean;
}

/** True when `p` is `root` itself or a descendant of it (both absolute). */
function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve a caller-supplied path to the target a write/read would really touch.
 * Both the requested path and the workspace root are resolved with
 * `realpathish`, so a symlinked workspace, a symlinked target and a symlinked
 * parent all compare in the same (real) namespace.
 */
export function resolveRealTarget(cwd: string, p: string, workspace: string): RealTarget {
  const requested = path.resolve(cwd, p);
  const real = realpathish(requested);
  return { requested, real, inside: within(realpathish(path.resolve(workspace)), real) };
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

/** Standard benign environment variables that are always safe to inherit. */
const SAFE_ENV_EXACT = new Set([
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_ENV",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPAGER",
  "GIT_PAGER",
  "LESS",
  "HOSTNAME",
  "DISPLAY",
]);

/** Environment names that must never reach a child process (segment-bounded or suffix). */
const SECRET_ENV =
  /(?:^|_)(?:key|keys|token|tokens|secret|secrets|password|passwords|passwd|pass|pwd|auth|credential|credentials|dsn|cookie|cookies|private_key|api_key|access_key|signing_key|connection_string|kubeconfig|bearer)(?:$|_)/i;
/**
 * Suffix rule catching compound credential names without underscores
 * (e.g. `APIKEY`, `AUTHTOKEN`, `MYSECRET`, `KUBECONFIG`, `SESSIONCOOKIE`).
 */
const SECRET_ENV_NAME = /(?:key|token|secret|password|passwd|cookie|dsn|credentials|connection_string|kubeconfig)$/i;
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
 * shapes: the broadened segment rule, the suffix rule, and the value rule
 * for connection strings.
 */
export function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CREDENTIAL_IN_URL.test(v)) continue;
    if (!SAFE_ENV_EXACT.has(k) && (SECRET_ENV.test(k) || SECRET_ENV_NAME.test(k))) continue;
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

/**
 * Unicode format/invisible characters that make a displayed command differ from
 * the executed one: bidi controls (U+202A-202E, U+2066-2069, U+200E/F), zero
 * width characters (U+200B-200D, U+2060, U+FEFF) and the line/paragraph
 * separators U+2028/U+2029. Shell commands containing any are refused.
 */
export const INVISIBLE_UNICODE = /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

/** Clear refusal text for INVISIBLE_UNICODE, or undefined when the text is clean. */
export function invisibleUnicodeError(text: string, what: string): string | undefined {
  const m = INVISIBLE_UNICODE.exec(text);
  if (m === null) return undefined;
  const cp = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return `invisible or direction-changing Unicode character U+${cp} is not allowed in ${what} (it would make the displayed command differ from the one that runs)`;
}

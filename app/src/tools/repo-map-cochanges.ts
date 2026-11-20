/**
 * repo-map-cochanges.ts — EXPERIMENTAL git co-change weighting for `repo_map`.
 *
 * ALL behaviour is gated by `HZ_REPO_COCHANGE=1` (default off). With the flag
 * unset `computeCochangeBonuses` returns an empty map without spawning anything,
 * so `repo_map` output is byte-identical to the lexical-only map.
 *
 * Mechanism: over a BOUNDED commit window (default 50, hard cap 500) run
 * `git -C <workspace> log --name-only --format=%x00 --max-count=<window>` through
 * the single guarded `spawnOwned` path (NF-071). Files changed together in one
 * commit form unordered pairs; pair counts are normalized to a bounded bonus in
 * [0, MAX_BONUS=0.25], capped to MAX_PAIRS pairs. The result is cached in the
 * existing repo-map cache dir keyed by `(repoHead, window, filePairKeys)` with
 * an owner-only dir (0700), 0600 file and a serialized-size cap.
 *
 * FAIL CLOSED: no bonus when the flag is off, the workspace is not trusted, git
 * is missing, spawn is refused, the head cannot be resolved, or history is
 * empty. Every failure returns an empty map — never a guess, never a throw into
 * the map call. The runner is injectable so tests can use a fake instead of a
 * real process; the default runner is `spawnOwned`.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "../core/canon";
import { spawnOwned } from "../core/owned-spawn";
import { workspaceHooksTrusted } from "../core/trust";
import { repoMapCacheDir } from "./repo-map-cache";

/** The one flag that enables co-change weighting. */
export const COCHANGE_FLAG = "HZ_REPO_COCHANGE";
/** True only when the experimental flag is explicitly `1`. */
export function cochangesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COCHANGE_FLAG] === "1";
}

export const DEFAULT_COCHANGE_WINDOW = 50;
export const MAX_COCHANGE_WINDOW = 500;
/** Upper bound on the normalized edge bonus (matching aider-style co-change caps). */
export const MAX_BONUS = 0.25;
/** Hard cap on the number of tracked pairs (kept by highest count, then key). */
export const MAX_PAIRS = 4_000;
/** Serialized-byte cap for the cache file. */
export const MAX_CACHE_BYTES = 512 * 1024;
const CACHE_VERSION = 1;

/** Canonical, order-independent key for an unordered file pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Trust guard: a workspace is trusted only when explicitly listed. */
export function cochangeWorkspaceTrusted(workspace: string, trusted: readonly string[] | undefined): boolean {
  return workspaceHooksTrusted(workspace, trusted);
}

/* ------------------------------ pure core -------------------------------- */

/** Count unordered file pairs that occur together in a commit. Pure. */
export function countPairCochanges(commits: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of commits) {
    const files = [...new Set(raw)].filter((f) => f !== "").sort();
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const key = pairKey(files[i] as string, files[j] as string);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Normalize pair counts to bounded bonuses in [0, MAX_BONUS]. The highest count
 * maps to MAX_BONUS; others scale linearly. Over MAX_PAIRS pairs the lowest
 * counts are dropped (ties broken by key) so the map stays bounded.
 */
export function normalizeBonuses(counts: ReadonlyMap<string, number>): Map<string, number> {
  const ranked = [...counts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1));
  const kept = ranked.slice(0, MAX_PAIRS);
  const max = kept.length > 0 ? (kept[0] as [string, number])[1] : 0;
  const bonuses = new Map<string, number>();
  if (max <= 0) return bonuses;
  for (const [key, count] of kept) {
    const bonus = Math.min(MAX_BONUS, (count / max) * MAX_BONUS);
    if (bonus > 0) bonuses.set(key, bonus);
  }
  return bonuses;
}

/** Parse `git log --name-only --format=` output into per-commit file lists. Pure. */
export function parseGitLog(stdout: string): string[][] {
  const commits: string[][] = [];
  let current: string[] = [];
  // `--format=%x00` emits an explicit NUL commit separator; blank lines are
  // also accepted as separators for injected/simple runner output.
  for (const raw of stdout.replace(/\0/g, "\n").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      if (current.length > 0) commits.push(current);
      current = [];
      continue;
    }
    // Fail closed on paths that escape the workspace or look like git metadata.
    if (path.isAbsolute(line) || line.startsWith("..") || line.startsWith(".git/")) continue;
    current.push(line);
  }
  if (current.length > 0) commits.push(current);
  return commits;
}

/* ----------------------------- spawn runner ------------------------------ */

export interface GitRunResult {
  ok: boolean;
  stdout: string;
}

export type GitRunner = (
  cmd: string[],
  opts: { cwd: string; stateDir: string; label: string },
) => Promise<GitRunResult>;

/** The production runner: the one guarded `spawnOwned` path, foreground. */
const ownedGitRunner: GitRunner = async (cmd, opts) => {
  const { proc } = await spawnOwned(cmd, {
    stateDir: opts.stateDir,
    label: opts.label,
    longLived: false,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    sandboxWrap: false, // a bounded read-only git query; no OS-wrap needed
  });
  const stdout = await new Response(proc.stdout).text();
  // Drain stderr so the child never blocks on a full pipe.
  void proc.stderr.cancel().catch(() => undefined);
  const code = await proc.exited;
  return { ok: code === 0, stdout };
};

/* -------------------------------- cache ---------------------------------- */

interface CochangeCache {
  version: number;
  key: string;
  bonuses: Record<string, number>;
}

function cacheKey(repoHead: string, window: number, filePairKeys: readonly string[]): string {
  return sha256Hex(canonicalJson({ repoHead, window, filePairKeys: [...filePairKeys].sort() }));
}

function loadCochangeCache(file: string, key: string): Map<string, number> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as CochangeCache;
    if (value?.version !== CACHE_VERSION || value.key !== key) return undefined;
    const bonuses = new Map<string, number>();
    for (const [pair, bonus] of Object.entries(value.bonuses ?? {})) {
      if (typeof bonus !== "number" || !Number.isFinite(bonus) || bonus <= 0 || bonus > MAX_BONUS) return undefined;
      bonuses.set(pair, bonus);
    }
    return bonuses;
  } catch {
    return undefined;
  }
}

const isUnix = process.platform !== "win32";

function saveCochangeCache(file: string, key: string, bonuses: ReadonlyMap<string, number>): void {
  const body = canonicalJson({
    version: CACHE_VERSION,
    key,
    bonuses: Object.fromEntries([...bonuses.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  if (Buffer.byteLength(body, "utf8") > MAX_CACHE_BYTES) return;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    mkdirSync(dir, { recursive: true });
    if (isUnix) chmodSync(dir, statSync(dir).mode & 0o700);
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    if (isUnix) chmodSync(file, 0o600);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------- main API -------------------------------- */

export interface CochangeOptions {
  workspace: string;
  /** Kernel state dir for the guarded spawn ledger. */
  stateDir: string;
  /** Trust gate: pass `cochangeWorkspaceTrusted(...)`; defaults to false (fail closed). */
  trusted?: boolean;
  /** Commit window; clamped to [1, MAX_COCHANGE_WINDOW]. */
  window?: number;
  /** Optional file subset whose pair keys form part of the cache key. */
  files?: readonly string[];
  /** Injectable runner for tests; defaults to the guarded `spawnOwned` runner. */
  runner?: GitRunner;
  /** Cache dir override for tests; defaults to the repo-map cache dir. */
  cacheDir?: string;
  /**
   * When false, skip writing `cochange.json` (under-admission deny/ask on the
   * cache path). Default true. Read/compute still run when otherwise allowed.
   */
  persistCache?: boolean;
}

/** Absolute path of the durable co-change cache for a workspace. */
export function cochangeCachePath(workspace: string, cacheDir?: string): string {
  return path.join(cacheDir ?? repoMapCacheDir(workspace), "cochange.json");
}

/**
 * Compute bounded co-change bonuses. Returns an empty map (no bonus) whenever
 * the flag is off, the workspace is untrusted, git/head/history is missing, or
 * a spawn is refused. Never throws into the map call.
 */
export async function computeCochangeBonuses(opts: CochangeOptions): Promise<Map<string, number>> {
  if (!cochangesEnabled()) return new Map();
  if (opts.trusted !== true) return new Map();
  const runner = opts.runner ?? ownedGitRunner;
  const window = Math.max(1, Math.min(MAX_COCHANGE_WINDOW, Math.floor(opts.window ?? DEFAULT_COCHANGE_WINDOW)));
  const files = [...new Set((opts.files ?? []).map((f) => f.replace(/^\.\//, "")))].sort();
  const filePairKeys: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) filePairKeys.push(pairKey(files[i] as string, files[j] as string));
  }
  const cacheFile = cochangeCachePath(opts.workspace, opts.cacheDir);
  const headResult = await safeRun(runner, ["git", "-C", opts.workspace, "rev-parse", "HEAD"], opts, "cochange:head");
  const repoHead = headResult?.stdout.trim() ?? "";
  if (repoHead === "") return new Map();
  const key = cacheKey(repoHead, window, filePairKeys);
  const cached = loadCochangeCache(cacheFile, key);
  if (cached !== undefined) return cached;
  const logResult = await safeRun(
    runner,
    ["git", "-C", opts.workspace, "log", "--name-only", "--format=%x00", `--max-count=${window}`],
    opts,
    "cochange:log",
  );
  if (logResult === undefined) return new Map();
  const commits = parseGitLog(logResult.stdout);
  if (commits.length === 0) return new Map();
  const bonuses = normalizeBonuses(countPairCochanges(commits));
  if (bonuses.size === 0) return new Map();
  if (opts.persistCache !== false) saveCochangeCache(cacheFile, key, bonuses);
  return bonuses;
}

async function safeRun(
  runner: GitRunner,
  cmd: string[],
  opts: CochangeOptions,
  label: string,
): Promise<GitRunResult | undefined> {
  try {
    const result = await runner(cmd, { cwd: opts.workspace, stateDir: opts.stateDir, label });
    return result.ok ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * paths.ts — canonical state paths with in-place legacy compatibility.
 *
 * `docs/_conventions.md` §1 names the canonical workspace config dir `.hz/` and
 * the canonical user config dir `~/.config/horizon/`; RC-16(f) puts kernel state
 * at `<workspace>/.hz/state/kernel/`, and `docs/12-sessions-state.md` §4.1 owns
 * the concrete layout (notably `<workspace>/.hz/state/hzcode.db`).
 *
 * The shipped v0.1 tree is `<workspace>/.hzcode/` (and `~/.hzcode/` for user
 * config). This module is the one resolution rule every state path goes through:
 *
 *   - An EXISTING `<workspace>/.hzcode/` is honoured IN PLACE — forever. State
 *     is never split and never migrated implicitly: every path under it keeps
 *     its shipped name (`kernel/`, `db.sqlite`, `spills/`, `skills/`, `history`).
 *   - A workspace without one uses the canonical tree `<workspace>/.hz/state/`:
 *     the shipped relative layout mirrored under `state/`, except where
 *     `docs/12` §4.1 is concrete — kernel state is `state/kernel`, the session
 *     database is `state/hzcode.db` (the physical `hz.db` of §1's storage-key
 *     block). Paths the doc does not name (`spills/`, `skills/`, `history`) keep
 *     their shipped relative names beneath `state/`.
 *   - User config: an EXISTING `~/.hzcode/` is honoured in place; otherwise
 *     `~/.config/horizon/`.
 *
 * Both decisions are made on the filesystem as it is at call time ("if it
 * exists" wins) and are symlink-safe: the decision is taken against the resolved
 * workspace (existing ancestors followed, `realpathish` — the same helper the
 * workspace scope uses) and an entry found through `lstat` counts as present, so
 * a symlinked workspace or a symlinked `.hzcode` cannot flip the decision or
 * split the tree.
 *
 * Migration of a legacy workspace to the canonical tree is explicit future work;
 * nothing here moves bytes.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** The shipped workspace state dir: honoured in place wherever it exists. */
export const LEGACY_WORKSPACE_DIR = ".hzcode";
/** The canonical workspace config dir (`_conventions.md` §1). */
export const CANONICAL_WORKSPACE_DIR = ".hz";
/** The canonical state subtree under the config dir (`docs/12` §4.1). */
export const CANONICAL_STATE_DIR = "state";
/** The shipped user config dir: honoured in place wherever it exists. */
export const LEGACY_USER_DIR = ".hzcode";
/** The canonical user config dir (`_conventions.md` §1). */
export const CANONICAL_USER_DIR = path.join(".config", "horizon");

/**
 * Resolve a path to where it really lives, following symlinks for the portion
 * that exists on disk. A path that does not exist yet is resolved through its
 * deepest existing ancestor, so a symlinked parent cannot hide where a new file
 * will actually land. Falls back to the lexical path when nothing can be
 * resolved (e.g. the root itself).
 */
export function realpathish(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Present on disk, whatever it is: a directory, a file, or a symlink (even dangling). */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Resolved layout for one workspace: the caller's spelling plus the one decision. */
interface StateLayout {
  /** The workspace under the caller's spelling (paths keep the caller's symlinks). */
  base: string;
  /** True when `<workspace>/.hzcode/` exists and must be used in place. */
  legacy: boolean;
}

/**
 * The one resolution rule. The legacy test runs on the resolved workspace
 * (`realpathish`: existing ancestors followed), so a symlinked workspace decides
 * exactly like its target; `lstat` makes a symlinked `.hzcode` count as present.
 */
function layoutOf(workspace: string): StateLayout {
  const base = path.resolve(workspace);
  const resolved = realpathish(base);
  return { base, legacy: entryExists(path.join(resolved, LEGACY_WORKSPACE_DIR)) };
}

/**
 * True when this workspace resolves to the legacy tree: `<workspace>/.hzcode/`
 * exists (checked through the resolved workspace, so a symlinked workspace
 * decides exactly like its target).
 */
export function isLegacyWorkspace(workspace: string): boolean {
  return layoutOf(workspace).legacy;
}

/**
 * The workspace config dir: the legacy `.hzcode/` when it exists (used in
 * place), else the canonical `.hz/`. Returned under the caller's spelling of
 * `workspace`, so a symlinked workspace keeps its own paths.
 */
export function stateRoot(workspace: string): string {
  const { base, legacy } = layoutOf(workspace);
  return path.join(base, legacy ? LEGACY_WORKSPACE_DIR : CANONICAL_WORKSPACE_DIR);
}

/**
 * The state tree root: legacy `<workspace>/.hzcode/`; canonical
 * `<workspace>/.hz/state/` (docs/12 §4.1).
 */
export function workspaceStateDir(workspace: string): string {
  const { base, legacy } = layoutOf(workspace);
  return legacy
    ? path.join(base, LEGACY_WORKSPACE_DIR)
    : path.join(base, CANONICAL_WORKSPACE_DIR, CANONICAL_STATE_DIR);
}

/**
 * One path in the state tree under its tree-relative name: the shipped name in
 * a legacy workspace, the canonical name under `state/` otherwise.
 */
function statePath(workspace: string, legacyName: string, canonicalName: string = legacyName): string {
  const { base, legacy } = layoutOf(workspace);
  return legacy
    ? path.join(base, LEGACY_WORKSPACE_DIR, legacyName)
    : path.join(base, CANONICAL_WORKSPACE_DIR, CANONICAL_STATE_DIR, canonicalName);
}

/**
 * The kernel state directory: `<workspace>/.hzcode/kernel` (legacy, in place)
 * or `<workspace>/.hz/state/kernel` (canonical, RC-16(f)).
 */
export function kernelStateDir(workspace: string): string {
  return statePath(workspace, "kernel");
}

/**
 * The session database: `<workspace>/.hzcode/db.sqlite` (legacy, in place) or
 * `<workspace>/.hz/state/hzcode.db` (canonical, docs/12 §4.1).
 */
export function sessionDbPath(workspace: string): string {
  return statePath(workspace, "db.sqlite", "hzcode.db");
}

/**
 * Where over-cap tool output spills: `<workspace>/.hzcode/spills` (legacy) or
 * `<workspace>/.hz/state/spills` (canonical; the shipped relative name mirrored
 * under `state/` — docs/12 §4.1 does not name a spill directory).
 */
export function spillDir(workspace: string): string {
  return statePath(workspace, "spills");
}

/**
 * Content-addressed blob bodies (F7 reduced): `<workspace>/.hzcode/blobs` (legacy)
 * or `<workspace>/.hz/state/blobs` (canonical, docs/12 §4.1 two-level shards).
 */
export function blobsDir(workspace: string): string {
  return statePath(workspace, "blobs");
}

/**
 * Workspace skills: `<workspace>/.hzcode/skills` (legacy) or
 * `<workspace>/.hz/state/skills` (canonical; not named by docs/12 §4.1 — the
 * shipped relative name mirrored under `state/`).
 */
export function skillsDir(workspace: string): string {
  return statePath(workspace, "skills");
}

/**
 * The chat history file: `<workspace>/.hzcode/history` (legacy) or
 * `<workspace>/.hz/state/history` (canonical; not named by docs/12 §4.1 — the
 * shipped relative name mirrored under `state/`).
 */
export function historyFilePath(workspace: string): string {
  return statePath(workspace, "history");
}

/**
 * The user config dir for `home` (default: this user's home): the legacy
 * `~/.hzcode/` when it exists (used in place), else `~/.config/horizon/`.
 */
export function userConfigDir(home: string = homedir()): string {
  const base = path.resolve(home);
  const resolved = realpathish(base);
  return entryExists(path.join(resolved, LEGACY_USER_DIR))
    ? path.join(base, LEGACY_USER_DIR)
    : path.join(base, CANONICAL_USER_DIR);
}

/** User skills: `<user config dir>/skills` (`~/.hzcode/skills` legacy, in place). */
export function userSkillsDir(home: string = homedir()): string {
  return path.join(userConfigDir(home), "skills");
}

/* ------------------------- owner-only state helpers ------------------------- */

/** Owner-only modes required under `.hz/state` (docs/12 S-14, docs/03 D12). */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

const isUnix = process.platform !== "win32";

/**
 * Create `dir` (and missing parents) owner-only and tighten an existing
 * directory to 0700. Best-effort on non-Unix, where POSIX modes do not exist.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  if (isUnix) {
    try {
      chmodSync(dir, STATE_DIR_MODE);
    } catch {
      /* best effort: a vanished dir is recreated by the caller */
    }
  }
  return dir;
}

/** Post-create chmod 0600 (umask-proof); a missing target is not an error. */
export function chmodPrivateFile(file: string): void {
  if (!isUnix) return;
  try {
    chmodSync(file, STATE_FILE_MODE);
  } catch {
    /* best effort, exactly like SessionStore's owner-only pass */
  }
}

/** The SQLite database plus its WAL sidecars, owner-only when present. */
export function chmodSqliteFiles(dbPath: string): void {
  chmodPrivateFile(dbPath);
  chmodPrivateFile(`${dbPath}-wal`);
  chmodPrivateFile(`${dbPath}-shm`);
}

/**
 * The workspace state directory, made owner-only. For a canonical workspace
 * this is `<workspace>/.hz/state`; a shipped `<workspace>/.hzcode/` is used in
 * place (paths.ts owns the rule) and is never split.
 */
export function ensureWorkspaceStateDir(workspace: string): string {
  const dir = workspaceStateDir(workspace);
  ensurePrivateDir(dir);
  if (!isLegacyWorkspace(workspace)) ensureHarnessGitignore(workspace);
  return dir;
}

/**
 * The harness self-ignore: `<workspace>/.hz/.gitignore` containing `*`, so the
 * whole config/state tree stays out of the user's repository. Idempotent and
 * written 0600. Deliberately NOT called from index.ts (the integrator wires
 * it); the state path initializers call it before their first write.
 */
export function ensureHarnessGitignore(workspace: string): string {
  const dir = path.join(path.resolve(workspace), CANONICAL_WORKSPACE_DIR);
  const file = path.join(dir, ".gitignore");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* absent or unreadable: (re)write below */
    }
    if (current !== "*\n") writeFileSync(file, "*\n", { mode: STATE_FILE_MODE });
    chmodPrivateFile(file);
  } catch {
    /* best effort: a read-only config dir must not take the runtime down */
  }
  return file;
}

/**
 * One runtime state file under the canonical tree. When the file is absent
 * under `<workspace>/.hz/state/` but the pre-audit location
 * `<workspace>/.hz/<name>` exists, copy it (and its SQLite sidecars) into the
 * state tree first, owner-only. The legacy bytes are left in place for
 * inspection; every later write goes to the returned state path.
 */
export function workspaceStateFile(workspace: string, name: string): string {
  const target = path.join(workspaceStateDir(workspace), name);
  const legacy = path.join(stateRoot(workspace), name);
  if (target !== legacy) migrateLegacyFile(legacy, target);
  return target;
}

/** A read-only resolution: the state copy when present, else the legacy file. */
export function existingWorkspaceStateFile(workspace: string, name: string): string {
  const target = workspaceStateFile(workspace, name);
  if (existsSync(target)) return target;
  const legacy = path.join(stateRoot(workspace), name);
  return existsSync(legacy) ? legacy : target;
}

function migrateLegacyFile(legacy: string, target: string): void {
  if (existsSync(target) || !existsSync(legacy)) return;
  try {
    ensurePrivateDir(path.dirname(target));
    copyFileSync(legacy, target);
    chmodPrivateFile(target);
    for (const suffix of ["-wal", "-shm"]) {
      if (!existsSync(`${legacy}${suffix}`)) continue;
      copyFileSync(`${legacy}${suffix}`, `${target}${suffix}`);
      chmodPrivateFile(`${target}${suffix}`);
    }
  } catch {
    /* best effort: an unreadable legacy file leaves the caller on a fresh state file */
  }
}

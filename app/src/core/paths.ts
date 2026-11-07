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

import { lstatSync, realpathSync } from "node:fs";
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

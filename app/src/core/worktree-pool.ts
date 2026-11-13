/**
 * Process-local `hz/*` sibling worktree pool (docs/12 F11 reduced; ruling 266).
 *
 * ADAPTS forgecode T-15 sibling layout — not kernel leases or OwnerLog journals.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { validateWorktreeName, worktreeAddCommand, worktreeSiblingPath } from "./worktree";

export const WORKTREE_POOL_DEFAULT_MAX = 8;

export function worktreePoolMaxFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HZ_WORKTREE_POOL_MAX?.trim();
  if (raw === undefined || raw === "") return WORKTREE_POOL_DEFAULT_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return WORKTREE_POOL_DEFAULT_MAX;
  return Math.min(64, Math.floor(n));
}

export function hzBranchForName(name: string): string {
  return `hz/${name.trim()}`;
}

/** Derive pool name from a sibling path `../<repoBasename>-<name>`. */
export function siblingWorktreeName(repoRoot: string, worktreePath: string): string | undefined {
  const base = path.basename(path.resolve(repoRoot)) || "repo";
  const parent = path.resolve(repoRoot, "..");
  const resolved = path.resolve(worktreePath);
  const dir = path.basename(resolved);
  const parentDir = path.resolve(path.dirname(resolved));
  if (parentDir !== parent) return undefined;
  const prefix = `${base}-`;
  if (!dir.startsWith(prefix) || dir.length <= prefix.length) return undefined;
  return dir.slice(prefix.length);
}

export type GitWorktreeRow = { path: string; head?: string; branch?: string };

/** Parse `git worktree list --porcelain`. */
export function parseGitWorktreePorcelain(text: string): GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = [];
  let cur: GitWorktreeRow | undefined;
  for (const line of text.split(/\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: line.slice("worktree ".length).trim() };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    if (line.startsWith("branch ")) {
      const ref = line.slice(7).trim();
      cur.branch = ref.replace(/^refs\/heads\//, "");
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

export type WorktreePoolEntry = {
  name: string;
  path: string;
  branch?: string;
  role: "main" | "pool";
  dirty?: boolean;
};

export type WorktreePoolStatus = {
  repoRoot: string;
  max: number;
  entries: WorktreePoolEntry[];
  poolCount: number;
  atCapacity: boolean;
  gitOk: boolean;
  detail?: string;
};

export function inspectWorktreePool(
  repoRoot: string,
  opts: {
    max?: number;
    porcelain?: string;
    dirtyPaths?: ReadonlySet<string>;
  } = {},
): WorktreePoolStatus {
  const max = opts.max ?? WORKTREE_POOL_DEFAULT_MAX;
  const resolved = path.resolve(repoRoot);
  if (opts.porcelain === undefined || opts.porcelain.trim() === "") {
    return {
      repoRoot: resolved,
      max,
      entries: [],
      poolCount: 0,
      atCapacity: false,
      gitOk: false,
      detail: "not a git worktree listing (run inside a git repository)",
    };
  }
  const rows = parseGitWorktreePorcelain(opts.porcelain);
  const entries: WorktreePoolEntry[] = [];
  let poolCount = 0;
  for (const row of rows) {
    const rowPath = path.resolve(row.path);
    const siblingName = siblingWorktreeName(resolved, rowPath);
    const isMain = rowPath === resolved;
    const isPoolBranch = row.branch?.startsWith("hz/") === true;
    const isPoolSibling = siblingName !== undefined;
    if (isMain) {
      entries.push({ name: "(main)", path: rowPath, branch: row.branch, role: "main" });
      continue;
    }
    if (!isPoolBranch && !isPoolSibling) continue;
    const name = siblingName ?? row.branch?.replace(/^hz\//, "") ?? path.basename(rowPath);
    const dirty = opts.dirtyPaths?.has(rowPath);
    entries.push({ name, path: rowPath, branch: row.branch, role: "pool", dirty });
    poolCount += 1;
  }
  return {
    repoRoot: resolved,
    max,
    entries,
    poolCount,
    atCapacity: poolCount >= max,
    gitOk: true,
  };
}

export type WorktreeAcquireDecision =
  | { kind: "reuse"; dest: string; branch: string; name: string }
  | { kind: "add"; dest: string; branch: string; name: string; command: string }
  | { kind: "refuse"; reason: string };

export function resolveWorktreeAcquire(
  repoRoot: string,
  name: string,
  opts: {
    max?: number;
    porcelain?: string;
    destExists?: boolean;
  } = {},
): WorktreeAcquireDecision {
  const why = validateWorktreeName(name);
  if (why !== undefined) return { kind: "refuse", reason: why };
  const resolved = path.resolve(repoRoot);
  const dest = worktreeSiblingPath(resolved, name);
  const branch = hzBranchForName(name);
  const max = opts.max ?? WORKTREE_POOL_DEFAULT_MAX;
  const status =
    opts.porcelain !== undefined
      ? inspectWorktreePool(resolved, { max, porcelain: opts.porcelain })
      : undefined;
  const rows = opts.porcelain !== undefined ? parseGitWorktreePorcelain(opts.porcelain) : [];
  const match = rows.find((r) => path.resolve(r.path) === dest);
  const exists = opts.destExists ?? existsSync(dest);

  if (match) {
    if (match.branch !== undefined && match.branch !== branch) {
      return {
        kind: "refuse",
        reason: `${dest} is already a worktree on branch ${match.branch}, expected ${branch}`,
      };
    }
    return { kind: "reuse", dest, branch, name: name.trim() };
  }

  if (exists) {
    return {
      kind: "refuse",
      reason: `${dest} exists on disk but is not registered with git worktree list`,
    };
  }

  if (status?.atCapacity === true) {
    return {
      kind: "refuse",
      reason: `worktree pool full (${status.poolCount}/${max} hz sibling trees); remove one or raise HZ_WORKTREE_POOL_MAX`,
    };
  }

  return { kind: "add", dest, branch, name: name.trim(), command: worktreeAddCommand(resolved, name) };
}

export function formatWorktreePoolLines(status: WorktreePoolStatus): string[] {
  if (!status.gitOk) {
    return [status.detail ?? "worktree pool: git listing unavailable"];
  }
  const head = `hz worktree pool (process-local, max ${status.max}): ${status.poolCount} pooled`;
  if (status.entries.length === 0) return [head, "  (no hz/* sibling worktrees registered)"];
  const lines = [head];
  for (const e of status.entries) {
    const tag = e.role === "main" ? "main" : "idle";
    const br = e.branch ? ` [${e.branch}]` : "";
    const dirty = e.dirty ? " dirty" : "";
    lines.push(`  ${tag} ${e.name}${br} ${e.path}${dirty}`);
  }
  if (status.atCapacity) {
    lines.push(`  at capacity — reuse with hzcode --worktree <name> or prune old trees`);
  }
  return lines;
}

/**
 * durable-todos.ts — branch-scoped open todo persistence (Engram reduced; §8 #3/#4).
 *
 * Opt-in `HZ_TODO_DURABLE=1` persists under `.hz/state/handoffs.db` in table
 * `durable_todos` (same DB as Engram handoffs). Legacy `open-todos.json` is
 * imported once then removed. Session-scoped `todo` tool owns live mutations.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "./canon";
import { DURABLE_TODOS, handoffDbPath, resolveHandoffBranch, withHandoffDb } from "./memory/handoff";
import { assertSqliteReconcileBarrierClear } from "./session";

function nextDurableTodoId(rows: DurableTodoRow[]): string {
  let max = 0;
  for (const t of rows) {
    const n = Number(t.id.slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}
import { stateRoot } from "./paths";

export const OPEN_TODOS_FILE = "open-todos.json";
export const DURABLE_BRANCH_TRACK_FILE = "durable-todo-branch.json";
export const DURABLE_TODOS_MAX_PER_BRANCH = 64;

type DurableBranchTrackFile = { version: 1; lastBranch: string };

export function durableAutoMergeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return durableTodosEnabled(env) && env.HZ_TODO_DURABLE_AUTOMERGE === "1";
}

export type DurableTodoRow = {
  id: string;
  text: string;
  done: boolean;
  dropped?: boolean;
  dropReason?: string;
};

type DurableTodoFile = { version: 1; branches: Record<string, DurableTodoRow[]> };

export function durableTodosEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HZ_TODO_DURABLE === "1";
}

function legacyJsonPath(workspace: string): string {
  return path.join(stateRoot(workspace), OPEN_TODOS_FILE);
}

function branchTrackPath(workspace: string): string {
  return path.join(stateRoot(workspace), DURABLE_BRANCH_TRACK_FILE);
}

/** Public path for Guard admission / doctor (ruling 599). */
export function durableBranchTrackPath(workspace: string): string {
  return branchTrackPath(workspace);
}

export async function admitDurableBranchTrackWrite(workspace: string): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("./preds-writer");
  const refused = await admitPredsOutWrite(branchTrackPath(workspace), workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "durable-todo-branch refused:")
    .replace(/^preds write denied/, "durable-todo-branch denied")
    .replace(/^preds fs\.write requires approval/, "durable-todo-branch fs.write requires approval");
}

export async function admitDurableTodosDbWrite(workspace: string): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("./preds-writer");
  const refused = await admitPredsOutWrite(handoffDbPath(workspace), workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "durable-todos-db refused:")
    .replace(/^preds write denied/, "durable-todos-db denied")
    .replace(/^preds fs\.write requires approval/, "durable-todos-db fs.write requires approval");
}

export function readLastDurableBranch(workspace: string): string | undefined {
  const fp = branchTrackPath(workspace);
  if (!existsSync(fp)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as DurableBranchTrackFile;
    if (parsed?.version !== 1 || typeof parsed.lastBranch !== "string") return undefined;
    const b = parsed.lastBranch.trim();
    return b === "" ? undefined : b;
  } catch {
    return undefined;
  }
}

function persistLastDurableBranch(workspace: string, branch: string): void {
  const b = branch.trim();
  if (b === "") return;
  const dir = stateRoot(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = branchTrackPath(workspace);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, canonicalJson({ version: 1, lastBranch: b } satisfies DurableBranchTrackFile) + "\n", { mode: 0o600 });
  renameSync(tmp, fp);
}

/** Under-admission (ruling 599): Guard before durable-todo-branch.json persist. */
export async function recordLastDurableBranch(workspace: string, branch: string): Promise<string | undefined> {
  const refused = await admitDurableBranchTrackWrite(workspace);
  if (refused !== undefined) return refused;
  persistLastDurableBranch(workspace, branch);
  return undefined;
}

/**
 * When `HZ_TODO_DURABLE_AUTOMERGE=1`, copy open todos from the last recorded branch
 * into the current branch when the current branch store is empty (git checkout seam).
 * Under-admission (ruling 599): Guard handoffs.db + branch-track before any persist.
 */
export async function maybeAutoMergeDurableOnBranchChange(
  workspace: string,
): Promise<{ merged: number; fromBranch?: string; refused?: string }> {
  if (!durableAutoMergeEnabled()) return { merged: 0 };
  const dbRefused = await admitDurableTodosDbWrite(workspace);
  if (dbRefused !== undefined) return { merged: 0, refused: dbRefused };
  const trackRefused = await admitDurableBranchTrackWrite(workspace);
  if (trackRefused !== undefined) return { merged: 0, refused: trackRefused };
  const current = branchKeyForWorkspace(workspace);
  const last = readLastDurableBranch(workspace);
  if (last === undefined || last === current) {
    persistLastDurableBranch(workspace, current);
    return { merged: 0 };
  }
  const openOnCurrent = loadBranchTodosSqlite(workspace, current).filter((r) => !r.done && !r.dropped);
  if (openOnCurrent.length > 0) {
    persistLastDurableBranch(workspace, current);
    return { merged: 0 };
  }
  const stats = mergeDurableBranchOpenTodos(workspace, last, current);
  persistLastDurableBranch(workspace, current);
  return stats.merged > 0 ? { merged: stats.merged, fromBranch: last } : { merged: 0 };
}

function parseLegacyFile(workspace: string): DurableTodoFile {
  const fp = legacyJsonPath(workspace);
  if (!existsSync(fp)) return { version: 1, branches: {} };
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as DurableTodoFile;
    if (parsed?.version !== 1 || typeof parsed.branches !== "object") {
      return { version: 1, branches: {} };
    }
    return parsed;
  } catch {
    return { version: 1, branches: {} };
  }
}

function normalizeRows(rows: unknown[]): DurableTodoRow[] {
  return rows
    .filter(
      (r): r is DurableTodoRow =>
        r !== null &&
        typeof r === "object" &&
        typeof (r as DurableTodoRow).id === "string" &&
        typeof (r as DurableTodoRow).text === "string" &&
        typeof (r as DurableTodoRow).done === "boolean" &&
        ((r as DurableTodoRow).dropped === undefined || typeof (r as DurableTodoRow).dropped === "boolean") &&
        ((r as DurableTodoRow).dropReason === undefined || typeof (r as DurableTodoRow).dropReason === "string"),
    )
    .slice(0, DURABLE_TODOS_MAX_PER_BRANCH);
}

function migrateLegacyJsonIfNeeded(workspace: string): void {
  const fp = legacyJsonPath(workspace);
  if (!existsSync(fp)) return;
  assertSqliteReconcileBarrierClear("durable-todos.migrateLegacyJsonIfNeeded");
  const legacy = parseLegacyFile(workspace);
  const branches = Object.entries(legacy.branches);
  if (branches.length === 0) {
    unlinkSync(fp);
    return;
  }
  withHandoffDb(workspace, false, (db) => {
    db.run("BEGIN");
    try {
      for (const [branch, rows] of branches) {
        const trimmed = normalizeRows(rows);
        db.run(`DELETE FROM ${DURABLE_TODOS} WHERE branch = ?`, [branch]);
        for (const r of trimmed) {
          db.run(
            `INSERT OR REPLACE INTO ${DURABLE_TODOS} (branch, todo_id, text, done, dropped, drop_reason) VALUES (?, ?, ?, ?, ?, ?)`,
            [branch, r.id, r.text, r.done ? 1 : 0, r.dropped ? 1 : 0, r.dropReason ?? null],
          );
        }
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  });
  unlinkSync(fp);
}

function loadBranchTodosSqlite(workspace: string, branch: string): DurableTodoRow[] {
  migrateLegacyJsonIfNeeded(workspace);
  const rows =
    withHandoffDb(workspace, true, (db) =>
      db
        .query(
          `SELECT todo_id, text, done, dropped, drop_reason FROM ${DURABLE_TODOS} WHERE branch = ? ORDER BY todo_id ASC LIMIT ?`,
        )
        .all(branch, DURABLE_TODOS_MAX_PER_BRANCH),
    ) ?? [];
  return (rows as { todo_id: string; text: string; done: number; dropped: number; drop_reason: string | null }[]).map(
    (r) => ({
      id: r.todo_id,
      text: r.text,
      done: r.done !== 0,
      ...(r.dropped !== 0 ? { dropped: true, dropReason: r.drop_reason ?? undefined } : {}),
    }),
  );
}

function saveBranchTodosSqlite(workspace: string, branch: string, rows: DurableTodoRow[]): void {
  assertSqliteReconcileBarrierClear("durable-todos.saveBranchTodosSqlite");
  migrateLegacyJsonIfNeeded(workspace);
  const trimmed = normalizeRows(rows);
  withHandoffDb(workspace, false, (db) => {
    db.run("BEGIN");
    try {
      db.run(`DELETE FROM ${DURABLE_TODOS} WHERE branch = ?`, [branch]);
      for (const r of trimmed) {
        db.run(
          `INSERT INTO ${DURABLE_TODOS} (branch, todo_id, text, done, dropped, drop_reason) VALUES (?, ?, ?, ?, ?, ?)`,
          [branch, r.id, r.text, r.done ? 1 : 0, r.dropped ? 1 : 0, r.dropReason ?? null],
        );
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  });
}

/** Test-only: write legacy JSON (not used at runtime when durable store is on). */
export function saveBranchTodosLegacyJson(workspace: string, branch: string, rows: DurableTodoRow[]): void {
  const dir = stateRoot(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = legacyJsonPath(workspace);
  const data: DurableTodoFile = parseLegacyFile(workspace);
  data.branches[branch] = normalizeRows(rows);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, canonicalJson(data) + "\n", { mode: 0o600 });
  renameSync(tmp, fp);
}

export function branchKeyForWorkspace(workspace: string, override?: string): string {
  return resolveHandoffBranch(workspace, override).branch;
}

export function loadBranchTodos(workspace: string, branch?: string): DurableTodoRow[] {
  if (!durableTodosEnabled()) return [];
  const key = branch ?? branchKeyForWorkspace(workspace);
  return loadBranchTodosSqlite(workspace, key);
}

export function saveBranchTodos(workspace: string, branch: string, rows: DurableTodoRow[]): void {
  if (!durableTodosEnabled()) return;
  saveBranchTodosSqlite(workspace, branch, rows);
  persistLastDurableBranch(workspace, branch);
}

export function durableTodoStorePath(workspace: string): string {
  return handoffDbPath(workspace);
}

/** Distinct branch keys with at least one durable todo row. */
export function listDurableTodoBranches(workspace: string): string[] {
  if (!durableTodosEnabled()) return [];
  migrateLegacyJsonIfNeeded(workspace);
  const rows =
    withHandoffDb(workspace, true, (db) =>
      db.query(`SELECT DISTINCT branch FROM ${DURABLE_TODOS} ORDER BY branch ASC`).all(),
    ) ?? [];
  return (rows as { branch: string }[]).map((r) => r.branch).filter((b) => b !== "");
}

/**
 * Copy open todos from `fromBranch` into the current (or `toBranch`) durable store.
 * Dedupes by exact task text against open rows on the destination branch.
 */
export function mergeDurableBranchOpenTodos(
  workspace: string,
  fromBranch: string,
  toBranch?: string,
): { merged: number; skipped: number } {
  if (!durableTodosEnabled()) return { merged: 0, skipped: 0 };
  const from = fromBranch.trim();
  if (from === "") return { merged: 0, skipped: 0 };
  const dest = (toBranch ?? branchKeyForWorkspace(workspace)).trim();
  if (from === dest) return { merged: 0, skipped: 0 };
  const srcRows = loadBranchTodosSqlite(workspace, from).filter((r) => !r.done && !r.dropped);
  if (srcRows.length === 0) return { merged: 0, skipped: 0 };
  const destRows = loadBranchTodosSqlite(workspace, dest);
  const openTexts = new Set(destRows.filter((r) => !r.done && !r.dropped).map((r) => r.text));
  let merged = 0;
  let skipped = 0;
  for (const r of srcRows) {
    if (openTexts.has(r.text)) {
      skipped += 1;
      continue;
    }
    destRows.push({ id: nextDurableTodoId(destRows), text: r.text, done: false });
    openTexts.add(r.text);
    merged += 1;
  }
  if (merged > 0) saveBranchTodosSqlite(workspace, dest, destRows);
  return { merged, skipped };
}
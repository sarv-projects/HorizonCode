/**
 * saved-allows.ts — durable session-grant recall (docs/30 §8 #6 ADAPT OpenCode saved allows).
 *
 * Primary store: `saved_allows` in workspace `hzcode.db` (SQL). `saved-allows.json`
 * under state root is a 0600 export mirror. The next `createRuntime` rehydrates
 * rows as session grants via `kernel.makeGrant`. Exact targets only; no wildcards.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./canon";
import type { GuardKind } from "../contracts";
import { metricContract } from "./metrics";
import { sessionDbPath, stateRoot } from "./paths";
import { Database } from "bun:sqlite";
import type { KernelClient } from "./kernel";
import { recordSessionGrantExpiry } from "./session-grant-clock";
import { openCodeActionForGuardKind } from "./permission-vocabulary";
import {
  importJsonIntoSqlIfEmpty,
  loadSavedAllowsSql,
  upsertSavedAllowsSql,
} from "./saved-allows-sql";
import { shellSavedGrantTargets } from "./shell-split";

export const SAVED_ALLOWS_FILE = "saved-allows.json";
export const SAVED_ALLOWS_MAX = 64;

export type SavedAllowRow = {
  kind: GuardKind;
  target: string;
  /** OpenCode presentation action (redundant with kind; aids inspection). */
  action?: string;
  savedAt: string;
};

type SavedAllowsFile = {
  version: 1;
  allows: SavedAllowRow[];
};

export function savedAllowsPath(workspace: string): string {
  return path.join(stateRoot(workspace), SAVED_ALLOWS_FILE);
}

function loadSavedAllowsJsonFile(workspace: string): SavedAllowRow[] {
  const file = savedAllowsPath(workspace);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as SavedAllowsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.allows)) return [];
    return parsed.allows.filter(
      (row): row is SavedAllowRow =>
        typeof row?.kind === "string" &&
        typeof row?.target === "string" &&
        row.target !== "" &&
        !row.target.endsWith("*") &&
        typeof row?.savedAt === "string",
    );
  } catch {
    return [];
  }
}

function writeSavedAllowsJson(workspace: string, allows: SavedAllowRow[]): void {
  const dir = stateRoot(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = savedAllowsPath(workspace);
  const ordered = [...allows].sort((a, b) => a.savedAt.localeCompare(b.savedAt)).slice(-SAVED_ALLOWS_MAX);
  if (ordered.length === 0) return;
  const tmp = `${dest}.tmp-${sha256Hex(String(Date.now())).slice(0, 8)}`;
  const body = canonicalJson({ version: 1, allows: ordered } satisfies SavedAllowsFile);
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, dest);
}

function syncJsonMirror(workspace: string, rows: SavedAllowRow[]): void {
  if (rows.length === 0) return;
  writeSavedAllowsJson(workspace, rows);
}

export interface SavedAllowsSummary {
  rows: number;
  shaped: number;
  store: "hzcode.db" | "saved-allows.json" | "none";
  /** Human doctor detail — byte-stable for existing tests. */
  detail: string;
}

/** Shared read-only inspect for doctor human + H-7 publication (never creates db). */
export function inspectSavedAllows(workspace: string): SavedAllowsSummary {
  let rows: SavedAllowRow[] = [];
  const dbPath = sessionDbPath(workspace);
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const hasTable = db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_allows'")
          .get();
        if (hasTable) {
          const raw = db
            .query(`SELECT kind, target, action, saved_at FROM saved_allows ORDER BY saved_at DESC`)
            .all() as Array<{ kind: string; target: string; action: string | null; saved_at: string }>;
          rows = raw
            .map((r) => ({
              kind: r.kind as GuardKind,
              target: r.target,
              action: r.action ?? undefined,
              savedAt: r.saved_at,
            }))
            .filter((r) => r.target !== "" && !r.target.endsWith("*"));
        }
      } finally {
        db.close();
      }
    } catch {
      /* corrupt db — fall through to JSON */
    }
  }
  if (rows.length === 0) rows = loadSavedAllowsJsonFile(workspace);
  if (rows.length === 0) {
    const emptyJson = existsSync(savedAllowsPath(workspace));
    return {
      rows: 0,
      shaped: 0,
      store: "none",
      detail: emptyJson
        ? "saved-allows.json present but empty"
        : "no saved allows (hzcode.db or saved-allows.json)",
    };
  }
  const shaped = rows.filter((r) => typeof r.action === "string" && r.action !== "").length;
  const shapeNote = shaped > 0 ? `; ${shaped} with {action,resource} shape` : "";
  const store: SavedAllowsSummary["store"] =
    existsSync(dbPath) && rows.length > 0 ? "hzcode.db" : "saved-allows.json";
  return {
    rows: rows.length,
    shaped,
    store,
    detail: `${rows.length} exact-target row(s) in ${store} (cap ${SAVED_ALLOWS_MAX}; rehydrated on session start)${shapeNote}`,
  };
}

/** Doctor / status: read-only counts (never creates `hzcode.db`). */
export function summarizeSavedAllows(workspace: string): string {
  return inspectSavedAllows(workspace).detail;
}

/**
 * H-7 parallel surface for saved-allows counts (ruling **544**). Human
 * `summarizeSavedAllows` stays byte-identical; these blocks are machine-readable only.
 */
export function savedAllowsPublication(workspace: string): string[] {
  const summary = inspectSavedAllows(workspace);
  const anchor = "none — first saved-allows inspect (no prior report of this workspace to compare against)";
  const population = `saved allows for workspace ${workspace}`;
  const excludes =
    "wildcard targets ending in * are filtered at inspect; corrupt hzcode.db falls through to JSON mirror";
  return [
    metricContract({
      metric: "saved allows exact-target rows",
      anchor,
      population,
      excludes,
      value: summary.rows,
    }),
    metricContract({
      metric: "saved allows rows with {action,resource} shape",
      anchor,
      population,
      excludes,
      value: summary.shaped,
    }),
    metricContract({
      metric: "saved allows store",
      anchor,
      population,
      excludes,
      value: summary.store,
    }),
    metricContract({
      metric: "saved allows cap",
      anchor,
      population,
      excludes,
      value: SAVED_ALLOWS_MAX,
    }),
  ];
}

export function loadSavedAllows(workspace: string): SavedAllowRow[] {
  const jsonRows = loadSavedAllowsJsonFile(workspace);
  importJsonIntoSqlIfEmpty(workspace, jsonRows, SAVED_ALLOWS_MAX);
  const sqlRows = loadSavedAllowsSql(workspace);
  if (sqlRows.length > 0) {
    return [...sqlRows].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  }
  return jsonRows;
}

/**
 * Under-admission (ruling 585): Guard `fs.write` on the session DB before
 * persisting a saved allow (JSON mirror is the same workspace-state write class).
 * Returns an error string on deny/ask/guard failure; undefined when allowed.
 */
export async function admitSavedAllowsWrite(workspace: string): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("./preds-writer");
  const refused = await admitPredsOutWrite(sessionDbPath(workspace), workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "saved-allows refused:")
    .replace(/^preds write denied/, "saved-allows denied")
    .replace(/^preds fs\.write requires approval/, "saved-allows fs.write requires approval");
}

/** Append or refresh one exact saved allow (deduped by kind+target, capped). */
export async function appendSavedAllow(
  workspace: string,
  kind: GuardKind,
  target: string,
): Promise<string | undefined> {
  const targets = shellSavedGrantTargets(kind, target);
  if (targets.length === 0) return undefined;
  const refused = await admitSavedAllowsWrite(workspace);
  if (refused !== undefined) return refused;
  const now = new Date().toISOString();
  const action = openCodeActionForGuardKind(kind);
  const newRows: SavedAllowRow[] = targets.map((t) => ({ kind, target: t, action, savedAt: now }));
  upsertSavedAllowsSql(workspace, newRows, SAVED_ALLOWS_MAX);
  syncJsonMirror(workspace, loadSavedAllows(workspace));
  return undefined;
}

/** Restore saved rows as session grants (same TTL as TUI "always"). */
export async function hydrateSavedGrants(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  ttlMs: number,
): Promise<number> {
  let count = 0;
  for (const row of loadSavedAllows(workspace)) {
    for (const t of shellSavedGrantTargets(row.kind, row.target)) {
      try {
        const grant = await kernel.makeGrant(row.kind, t, ttlMs, sessionId);
        recordSessionGrantExpiry(sessionId, row.kind, t, grant.expiry);
        count += 1;
      } catch {
        /* stale row; skip */
      }
    }
  }
  return count;
}
/**
 * auto-dream.ts — Wave 2 / Track 2A 4-Phase Auto-Dream Consolidation Engine
 * with Dual-Agent Sleep-Time Itemized SQLite Deltas.
 *
 * Lifecycle:
 *   - Dual-Gate Trigger (`shouldRunAutoDream`): requires BOTH >= 24h elapsed
 *     since the last dream (`minElapsedMs`) AND >= 5 sessions since the last
 *     dream (`minSessions`), guarded by an exclusive lockfile at
 *     `.hz/state/memory/auto-dream.lock` with stale-lock recovery.
 *   - Phase 1 (Orient): read current SQLite memory facts + topic inventory.
 *   - Phase 2 (Gather Signal): targeted, bounded scan of recent session turns,
 *     corrections, and decisions (never exhaustive raw replay).
 *   - Phase 3 (Consolidate): normalize relative dates -> ISO-8601, verify
 *     referenced file paths against `git ls-files` (or filesystem `stat`
 *     fallback), and apply itemized SQLite UPSERT / SUPERSEDE / DELETE deltas
 *     atomically via `store.ts` (respecting `HZ_R170_SQLITE_BARRIER=1`).
 *   - Phase 4 (Prune & Index): build a deterministic startup memory map
 *     (`buildStartupMemoryMap`) capped strictly at <= 200 lines.
 *
 * Source tree is strictly read-only. Opt-out via `HZ_AUTO_DREAM=0`.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { pidAlive } from "../file-lock";
import { sessionDbPath, workspaceStateDir } from "../paths";
import { PROJECT_BANK, type MemoryBankId } from "./banks";
import { listMemoryTopicFiles, MEMORY_MAX_LINES } from "./manifest";
import {
  applyMemoryDeltas,
  listMemoryFacts,
  type ApplyMemoryDeltasResult,
  type MemoryDelta,
  type StoredMemoryFact,
} from "./store";
import { applySupersession, factKey, type MemoryFactRow } from "./supersession";

export const AUTO_DREAM_ENV = "HZ_AUTO_DREAM";
export const DEFAULT_MIN_ELAPSED_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MIN_SESSIONS = 5;
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
export const DEFAULT_EMPTY_LOCK_GRACE_MS = 2_000;
export const STARTUP_MEMORY_MAP_MAX_LINES = MEMORY_MAX_LINES; // 200
export const DEFAULT_IDLE_DELAY_MS = 1_500;

const MAX_SCAN_SESSIONS = 10;
const MAX_TURNS_PER_SESSION = 12;
const MAX_TURN_SCAN_CHARS = 600;

export function autoDreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTO_DREAM_ENV] !== "0";
}

export function autoDreamDir(workspace: string): string {
  return path.join(workspaceStateDir(workspace), "memory");
}

export function autoDreamLockPath(workspace: string): string {
  return path.join(autoDreamDir(workspace), "auto-dream.lock");
}

export function autoDreamStatePath(workspace: string): string {
  return path.join(autoDreamDir(workspace), "auto-dream-state.json");
}

export interface AutoDreamState {
  lastDreamAtMs: number;
  lastDreamAtIso: string;
  sessionsConsolidated: number;
}

export function readAutoDreamState(workspace: string): AutoDreamState | undefined {
  const file = autoDreamStatePath(workspace);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AutoDreamState>;
    if (typeof parsed.lastDreamAtMs !== "number" || !Number.isFinite(parsed.lastDreamAtMs)) {
      return undefined;
    }
    return {
      lastDreamAtMs: parsed.lastDreamAtMs,
      lastDreamAtIso:
        typeof parsed.lastDreamAtIso === "string"
          ? parsed.lastDreamAtIso
          : new Date(parsed.lastDreamAtMs).toISOString(),
      sessionsConsolidated:
        typeof parsed.sessionsConsolidated === "number" ? parsed.sessionsConsolidated : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeAutoDreamState(workspace: string, state: AutoDreamState): void {
  const file = autoDreamStatePath(workspace);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Count sessions updated after `sinceMs` in the workspace session DB (read-only). */
export function countSessionsSince(workspace: string, sinceMs: number): number {
  const dbPath = sessionDbPath(workspace);
  if (!existsSync(dbPath)) return 0;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    if (sinceMs <= 0) {
      const row = db.query(`SELECT count(*) AS n FROM sessions`).get() as { n: number } | null;
      return row?.n ?? 0;
    }
    const sinceIso = new Date(sinceMs).toISOString();
    const row = db
      .query(`SELECT count(*) AS n FROM sessions WHERE updated > ?`)
      .get(sinceIso) as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export interface AutoDreamGateOptions {
  nowMs?: number;
  minElapsedMs?: number;
  minSessions?: number;
  sessionsSinceLastDream?: number;
  lastDreamAtMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface AutoDreamGateDecision {
  shouldRun: boolean;
  reason: "eligible" | "disabled" | "elapsed_gate" | "session_gate" | "both_gates";
  elapsedMs: number;
  minElapsedMs: number;
  sessionsSinceLastDream: number;
  minSessions: number;
  lastDreamAtMs: number;
}

/**
 * Dual-Gate Trigger: requires BOTH >= `minElapsedMs` (default 24h) elapsed
 * since last dream AND >= `minSessions` (default 5) sessions since last dream.
 */
export function shouldRunAutoDream(
  workspace: string,
  opts: AutoDreamGateOptions = {},
): AutoDreamGateDecision {
  const nowMs = opts.nowMs ?? Date.now();
  const minElapsedMs = opts.minElapsedMs ?? DEFAULT_MIN_ELAPSED_MS;
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const env = opts.env ?? process.env;
  const prior = readAutoDreamState(workspace);
  const lastDreamAtMs = opts.lastDreamAtMs ?? prior?.lastDreamAtMs ?? 0;
  const elapsedMs = Math.max(0, nowMs - lastDreamAtMs);
  const sessionsSinceLastDream =
    opts.sessionsSinceLastDream ?? countSessionsSince(workspace, lastDreamAtMs);

  if (!autoDreamEnabled(env)) {
    return {
      shouldRun: false,
      reason: "disabled",
      elapsedMs,
      minElapsedMs,
      sessionsSinceLastDream,
      minSessions,
      lastDreamAtMs,
    };
  }

  const elapsedOk = elapsedMs >= minElapsedMs;
  const sessionsOk = sessionsSinceLastDream >= minSessions;

  if (!elapsedOk && !sessionsOk) {
    return {
      shouldRun: false,
      reason: "both_gates",
      elapsedMs,
      minElapsedMs,
      sessionsSinceLastDream,
      minSessions,
      lastDreamAtMs,
    };
  }
  if (!elapsedOk) {
    return {
      shouldRun: false,
      reason: "elapsed_gate",
      elapsedMs,
      minElapsedMs,
      sessionsSinceLastDream,
      minSessions,
      lastDreamAtMs,
    };
  }
  if (!sessionsOk) {
    return {
      shouldRun: false,
      reason: "session_gate",
      elapsedMs,
      minElapsedMs,
      sessionsSinceLastDream,
      minSessions,
      lastDreamAtMs,
    };
  }
  return {
    shouldRun: true,
    reason: "eligible",
    elapsedMs,
    minElapsedMs,
    sessionsSinceLastDream,
    minSessions,
    lastDreamAtMs,
  };
}

// ---------------------------------------------------------------------------
// Exclusive Lockfile with Stale-Lock Recovery
// ---------------------------------------------------------------------------

interface LockPayload {
  pid: number;
  token: string;
  acquiredAtMs: number;
}

export interface AutoDreamLockOptions {
  nowMs?: number;
  staleMs?: number;
  emptyGraceMs?: number;
  isAlive?: (pid: number) => boolean;
}

export type AutoDreamLockResult =
  | {
      acquired: true;
      lockPath: string;
      token: string;
      reclaimedStale: boolean;
      release: () => void;
    }
  | {
      acquired: false;
      lockPath: string;
      reason: "locked" | "unwritable";
      holderPid?: number;
    };

function parseLockPayload(raw: string): LockPayload | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockPayload>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.acquiredAtMs === "number" &&
      Number.isFinite(parsed.acquiredAtMs)
    ) {
      return { pid: parsed.pid, token: parsed.token, acquiredAtMs: parsed.acquiredAtMs };
    }
  } catch {
    /* corrupt payload */
  }
  return undefined;
}

function tryCreateExclusiveLock(
  lockPath: string,
  nowMs: number,
): { ok: true; token: string } | { ok: false; code?: string } {
  const token = randomBytes(8).toString("hex");
  let fd: number;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fd = openSync(lockPath, "wx", 0o600);
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException | null)?.code };
  }
  try {
    const payload: LockPayload = { pid: process.pid, token, acquiredAtMs: nowMs };
    writeSync(fd, JSON.stringify(payload) + "\n");
  } finally {
    closeSync(fd);
  }
  return { ok: true, token };
}

/** Non-blocking exclusive lock acquisition with stale-lock recovery. */
export function acquireAutoDreamLock(
  workspace: string,
  opts: AutoDreamLockOptions = {},
): AutoDreamLockResult {
  const lockPath = autoDreamLockPath(workspace);
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const emptyGraceMs = opts.emptyGraceMs ?? DEFAULT_EMPTY_LOCK_GRACE_MS;
  const isAlive = opts.isAlive ?? pidAlive;

  const makeRelease = (token: string) => () => {
    try {
      const current = parseLockPayload(readFileSync(lockPath, "utf8"));
      if (current !== undefined && current.token === token) {
        unlinkSync(lockPath);
      }
    } catch {
      /* already removed */
    }
  };

  const first = tryCreateExclusiveLock(lockPath, nowMs);
  if ("token" in first) {
    return {
      acquired: true,
      lockPath,
      token: first.token,
      reclaimedStale: false,
      release: makeRelease(first.token),
    };
  }
  if (first.code !== "EEXIST") {
    return { acquired: false, lockPath, reason: "unwritable" };
  }

  // Contended: inspect holder for staleness.
  let raw = "";
  let mtimeMs = nowMs;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // Lock vanished between EEXIST and read; retry once.
    const retry = tryCreateExclusiveLock(lockPath, nowMs);
    if (retry.ok) {
      return {
        acquired: true,
        lockPath,
        token: retry.token,
        reclaimedStale: false,
        release: makeRelease(retry.token),
      };
    }
    return { acquired: false, lockPath, reason: "locked" };
  }

  const holder = parseLockPayload(raw);
  const isStale =
    holder !== undefined
      ? !isAlive(holder.pid) || nowMs - holder.acquiredAtMs >= staleMs
      : nowMs - mtimeMs >= emptyGraceMs;

  if (!isStale) {
    return {
      acquired: false,
      lockPath,
      reason: "locked",
      holderPid: holder?.pid,
    };
  }

  // Reclaim stale lock atomically by renaming aside, then retry exclusive create.
  const grave = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, grave);
    rmSync(grave, { force: true });
  } catch {
    return { acquired: false, lockPath, reason: "locked", holderPid: holder?.pid };
  }

  const second = tryCreateExclusiveLock(lockPath, nowMs);
  if (second.ok) {
    return {
      acquired: true,
      lockPath,
      token: second.token,
      reclaimedStale: true,
      release: makeRelease(second.token),
    };
  }
  return { acquired: false, lockPath, reason: "locked", holderPid: holder?.pid };
}

// ---------------------------------------------------------------------------
// Phase 1 — Orient
// ---------------------------------------------------------------------------

export interface OrientSnapshot {
  bank: MemoryBankId;
  facts: StoredMemoryFact[];
  factsByKey: Map<string, StoredMemoryFact[]>;
  topics: string[];
}

export function orientMemory(
  workspace: string,
  opts: { bank?: MemoryBankId; home?: string } = {},
): OrientSnapshot {
  const bank = opts.bank ?? PROJECT_BANK;
  const facts = listMemoryFacts(workspace, bank, opts.home);
  const factsByKey = new Map<string, StoredMemoryFact[]>();
  for (const fact of facts) {
    const key = factKey(fact.content);
    const group = factsByKey.get(key);
    if (group === undefined) factsByKey.set(key, [fact]);
    else group.push(fact);
  }
  const topics = listMemoryTopicFiles(workspace);
  return { bank, facts, factsByKey, topics };
}

// ---------------------------------------------------------------------------
// Phase 2 — Gather Signal (targeted scan, never exhaustive raw replay)
// ---------------------------------------------------------------------------

export interface SessionSignalTurn {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestampIso: string;
}

export interface CandidateSignal {
  sessionId: string;
  timestampIso: string;
  kind: "correction" | "decision" | "fact";
  key: string;
  rawText: string;
}

const CORRECTION_RE =
  /\b(actually,|correction:|instead of|don't use|do not use|never use|always use|prefer .+ over|switched to|moved to|renamed to)\b/i;
const DECISION_RE =
  /^\s*(?:[-*]\s*)?(?:decided|decision|convention|rule|remember|note|invariant|policy|architecture)\s*:\s*(.+)$/i;
const KEY_VALUE_RE = /^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9 _.-]{1,48})\s*:\s*(.{4,})$/;

function extractTextFromStoredMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
              return (part as { text: string }).text;
            }
            return "";
          })
          .filter((s) => s.length > 0)
          .join("\n");
      }
    } catch {
      /* fall through to plain text */
    }
  }
  return trimmed;
}

/** Read a bounded, targeted sample of recent session turns from hzcode.db. */
function readRecentSessionTurns(
  workspace: string,
  sinceMs: number,
  maxSessions = MAX_SCAN_SESSIONS,
  maxTurnsPerSession = MAX_TURNS_PER_SESSION,
): SessionSignalTurn[] {
  const dbPath = sessionDbPath(workspace);
  if (!existsSync(dbPath)) return [];
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const sinceIso = sinceMs > 0 ? new Date(sinceMs).toISOString() : "";
    const sessions = (
      sinceIso !== ""
        ? db
            .query(`SELECT id, updated FROM sessions WHERE updated > ? ORDER BY updated DESC LIMIT ?`)
            .all(sinceIso, maxSessions)
        : db.query(`SELECT id, updated FROM sessions ORDER BY updated DESC LIMIT ?`).all(maxSessions)
    ) as Array<{ id: string; updated: string }>;

    const turns: SessionSignalTurn[] = [];
    const msgStmt = db.prepare(
      `SELECT role, content, ts FROM messages
       WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
       ORDER BY seq DESC LIMIT ?`,
    );
    for (const s of sessions) {
      const rows = msgStmt.all(s.id, maxTurnsPerSession) as Array<{
        role: string;
        content: string;
        ts: string;
      }>;
      for (const row of rows.reverse()) {
        const text = extractTextFromStoredMessage(row.content);
        if (text === "") continue;
        turns.push({
          sessionId: s.id,
          role: row.role === "assistant" ? "assistant" : "user",
          content: text.slice(0, MAX_TURN_SCAN_CHARS),
          timestampIso: row.ts || s.updated || new Date().toISOString(),
        });
      }
    }
    return turns;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function gatherSessionSignal(
  workspace: string,
  opts: {
    sinceMs?: number;
    turns?: readonly SessionSignalTurn[];
    maxSessions?: number;
    maxTurnsPerSession?: number;
  } = {},
): CandidateSignal[] {
  const turns =
    opts.turns ??
    readRecentSessionTurns(
      workspace,
      opts.sinceMs ?? 0,
      opts.maxSessions ?? MAX_SCAN_SESSIONS,
      opts.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION,
    );

  const candidates: CandidateSignal[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    const lines = turn.content
      .slice(0, MAX_TURN_SCAN_CHARS)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.length <= 320);

    for (const rawLine of lines) {
      const cleaned = rawLine.replace(/^[-*]\s+/, "").trim();
      let kind: CandidateSignal["kind"] | undefined;
      if (DECISION_RE.test(cleaned)) {
        kind = "decision";
      } else if (CORRECTION_RE.test(cleaned)) {
        kind = "correction";
      } else if (KEY_VALUE_RE.test(cleaned) && !/^https?:/i.test(cleaned)) {
        kind = "fact";
      }
      if (kind === undefined) continue;

      const dedupeKey = cleaned.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      candidates.push({
        sessionId: turn.sessionId,
        timestampIso: turn.timestampIso,
        kind,
        key: factKey(cleaned),
        rawText: cleaned,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Phase 3 — Consolidate (Date Normalization, Path Verification, Itemized Deltas)
// ---------------------------------------------------------------------------

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatUtcMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function shiftUtcDays(anchor: Date, deltaDays: number): string {
  const d = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + deltaDays),
  );
  return formatUtcDate(d);
}

function shiftUtcMonths(anchor: Date, deltaMonths: number): string {
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + deltaMonths, 1));
  return formatUtcMonth(d);
}

/**
 * Normalize relative date phrases (`today`, `yesterday`, `tomorrow`,
 * `N days ago`, `in N days`, `last week`, `next week`, `N weeks ago`,
 * `last month`, `this month`, `next month`, `last year`, `this year`, `next year`)
 * into absolute ISO-8601 dates anchored to the session timestamp.
 */
export function normalizeRelativeDates(text: string, anchorIsoOrMs: string | number): string {
  const ms = typeof anchorIsoOrMs === "number" ? anchorIsoOrMs : Date.parse(anchorIsoOrMs);
  if (!Number.isFinite(ms)) return text;
  const anchor = new Date(ms);

  return text
    .replace(/\b(\d+)\s+days?\s+ago\b/gi, (_, n: string) => shiftUtcDays(anchor, -Number(n)))
    .replace(/\bin\s+(\d+)\s+days?\b/gi, (_, n: string) => shiftUtcDays(anchor, Number(n)))
    .replace(/\b(\d+)\s+weeks?\s+ago\b/gi, (_, n: string) => shiftUtcDays(anchor, -Number(n) * 7))
    .replace(/\bin\s+(\d+)\s+weeks?\b/gi, (_, n: string) => shiftUtcDays(anchor, Number(n) * 7))
    .replace(/\byesterday\b/gi, () => shiftUtcDays(anchor, -1))
    .replace(/\btoday\b/gi, () => shiftUtcDays(anchor, 0))
    .replace(/\btomorrow\b/gi, () => shiftUtcDays(anchor, 1))
    .replace(/\blast\s+week\b/gi, () => shiftUtcDays(anchor, -7))
    .replace(/\bnext\s+week\b/gi, () => shiftUtcDays(anchor, 7))
    .replace(/\blast\s+month\b/gi, () => shiftUtcMonths(anchor, -1))
    .replace(/\bthis\s+month\b/gi, () => shiftUtcMonths(anchor, 0))
    .replace(/\bnext\s+month\b/gi, () => shiftUtcMonths(anchor, 1))
    .replace(/\blast\s+year\b/gi, () => String(anchor.getUTCFullYear() - 1))
    .replace(/\bthis\s+year\b/gi, () => String(anchor.getUTCFullYear()))
    .replace(/\bnext\s+year\b/gi, () => String(anchor.getUTCFullYear() + 1));
}

const URL_STRIP_RE = /\b(?:https?|file|ssh|git):\/\/[^\s`"')\]>]+/gi;
const FILE_PATH_RE =
  /(?:^|[\s`"'(\[,:;])((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z][A-Za-z0-9]{0,9})(?=$|[\s`"')\].,:;?!])/g;

/** Extract workspace-relative file paths mentioned in a memory fact. */
export function extractReferencedFilePaths(text: string): string[] {
  const scrubbed = text.replace(URL_STRIP_RE, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of scrubbed.matchAll(FILE_PATH_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const normalized = raw.replace(/^\.\//, "").replace(/\\/g, "/");
    if (normalized.startsWith("../") || normalized.includes("/../")) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * List tracked files via `git ls-files` (read-only). Returns `undefined` when
 * the workspace is not a git repository or `git` is unavailable.
 */
export function listWorkspaceTrackedFiles(workspace: string): Set<string> | undefined {
  try {
    const proc = Bun.spawnSync(["git", "ls-files"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return undefined;
    const text = new TextDecoder().decode(proc.stdout);
    const files = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/\\/g, "/");
      if (trimmed !== "") files.add(trimmed);
    }
    return files;
  } catch {
    return undefined;
  }
}

function statExistsInsideWorkspace(workspace: string, relPath: string): boolean {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  try {
    const st = statSync(abs);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

export interface FilePathVerification {
  referenced: string[];
  missing: string[];
  valid: boolean;
}

/**
 * Verify all file paths referenced in `text` against `git ls-files` (when
 * available) with filesystem `stat` fallback.
 */
export function verifyFactFilePaths(
  workspace: string,
  text: string,
  opts: { trackedFiles?: ReadonlySet<string>; trustTrackedSetOnly?: boolean } = {},
): FilePathVerification {
  const referenced = extractReferencedFilePaths(text);
  if (referenced.length === 0) return { referenced: [], missing: [], valid: true };

  const missing: string[] = [];
  for (const rel of referenced) {
    let exists: boolean;
    if (opts.trackedFiles !== undefined) {
      if (opts.trustTrackedSetOnly === true) {
        exists = opts.trackedFiles.has(rel);
      } else {
        exists = opts.trackedFiles.has(rel) && statExistsInsideWorkspace(workspace, rel);
      }
    } else {
      exists = statExistsInsideWorkspace(workspace, rel);
    }
    if (!exists) missing.push(rel);
  }
  return { referenced, missing, valid: missing.length === 0 };
}

export interface ConsolidateOptions {
  nowIso?: string;
  trackedFiles?: ReadonlySet<string>;
  trustTrackedSetOnly?: boolean;
}

/**
 * Phase 3 — Plan structured, itemized SQLite delta operations
 * (`UPSERT` | `SUPERSEDE` | `DELETE`) without rewriting monolithic Markdown.
 */
export function planMemoryDeltas(
  workspace: string,
  orient: OrientSnapshot,
  signals: readonly CandidateSignal[],
  opts: ConsolidateOptions = {},
): MemoryDelta[] {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const trackedFiles =
    opts.trackedFiles !== undefined ? opts.trackedFiles : listWorkspaceTrackedFiles(workspace);
  const trustTrackedSetOnly = opts.trustTrackedSetOnly ?? opts.trackedFiles !== undefined;

  const deltas: MemoryDelta[] = [];
  const activeByContent = new Map<string, StoredMemoryFact>();
  const activeByKey = new Map<string, StoredMemoryFact>();

  // 1. Audit existing SQLite facts: prune dead file paths & normalize relative dates.
  for (const fact of orient.facts) {
    const key = factKey(fact.content);
    const pathCheck = verifyFactFilePaths(workspace, fact.content, {
      trackedFiles,
      trustTrackedSetOnly,
    });
    if (!pathCheck.valid) {
      deltas.push({
        op: "DELETE",
        id: fact.id,
        key,
        text: fact.content,
        reason: `dead_path: ${pathCheck.missing.join(", ")}`,
      });
      continue;
    }

    const anchor = fact.storedAt ?? nowIso;
    const normalized = normalizeRelativeDates(fact.content, anchor);
    if (normalized !== fact.content) {
      deltas.push({
        op: "SUPERSEDE",
        id: fact.id,
        key: factKey(normalized),
        text: normalized,
        replaces: fact.content,
        reason: "normalize_relative_dates",
        storedAt: anchor,
      });
      const updatedFact: StoredMemoryFact = {
        ...fact,
        content: normalized,
      };
      activeByContent.set(normalized, updatedFact);
      if (factKey(normalized) !== "") activeByKey.set(factKey(normalized), updatedFact);
      continue;
    }

    activeByContent.set(fact.content, fact);
    if (key !== "") {
      const prev = activeByKey.get(key);
      if (prev === undefined || fact.storedAtMs >= prev.storedAtMs) {
        activeByKey.set(key, fact);
      }
    }
  }

  // 2. Process gathered candidate signals into UPSERT / SUPERSEDE deltas.
  for (const signal of signals) {
    const normalized = normalizeRelativeDates(signal.rawText, signal.timestampIso).trim();
    if (normalized === "") continue;

    const pathCheck = verifyFactFilePaths(workspace, normalized, {
      trackedFiles,
      trustTrackedSetOnly,
    });
    if (!pathCheck.valid) continue;

    if (activeByContent.has(normalized)) continue;

    const key = factKey(normalized);
    const existingForKey = key !== "" ? activeByKey.get(key) : undefined;
    const hasExplicitColonKey = normalized.includes(":") && key !== "";

    if (hasExplicitColonKey && existingForKey !== undefined && existingForKey.content !== normalized) {
      deltas.push({
        op: "SUPERSEDE",
        id: existingForKey.id,
        key,
        text: normalized,
        replaces: existingForKey.content,
        reason: `supersede_${signal.kind}`,
        storedAt: signal.timestampIso,
      });
      activeByContent.delete(existingForKey.content);
      const nextFact: StoredMemoryFact = {
        id: existingForKey.id,
        bank: orient.bank,
        content: normalized,
        storedAt: signal.timestampIso,
        storedAtMs: Date.parse(signal.timestampIso) || 0,
      };
      activeByContent.set(normalized, nextFact);
      activeByKey.set(key, nextFact);
    } else {
      deltas.push({
        op: "UPSERT",
        key,
        text: normalized,
        reason: `gather_${signal.kind}`,
        storedAt: signal.timestampIso,
      });
      const nextFact: StoredMemoryFact = {
        id: normalized,
        bank: orient.bank,
        content: normalized,
        storedAt: signal.timestampIso,
        storedAtMs: Date.parse(signal.timestampIso) || 0,
      };
      activeByContent.set(normalized, nextFact);
      if (hasExplicitColonKey) activeByKey.set(key, nextFact);
    }
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Phase 4 — Prune & Index (`buildStartupMemoryMap`, strictly <= 200 lines)
// ---------------------------------------------------------------------------

export interface StartupMemoryMapOptions {
  maxLines?: number;
  bank?: MemoryBankId;
  home?: string;
  facts?: readonly StoredMemoryFact[];
  topics?: readonly string[];
}

export interface StartupMemoryMapResult {
  content: string;
  lineCount: number;
  totalActiveFacts: number;
  includedFacts: number;
  supersededCount: number;
  truncated: boolean;
}

/**
 * Build a deterministic startup memory map capped strictly at <= 200 lines,
 * ordered by active non-superseded facts (newest first, deterministic tie-break).
 */
export function buildStartupMemoryMap(
  workspace: string,
  opts: StartupMemoryMapOptions = {},
): StartupMemoryMapResult {
  const hardCap = Math.max(1, Math.min(opts.maxLines ?? STARTUP_MEMORY_MAP_MAX_LINES, STARTUP_MEMORY_MAP_MAX_LINES));
  const bank = opts.bank ?? PROJECT_BANK;
  const rawFacts = opts.facts ?? listMemoryFacts(workspace, bank, opts.home);
  const topics = opts.topics ?? listMemoryTopicFiles(workspace);

  const rows: MemoryFactRow[] = rawFacts.map((f) => ({
    id: f.id,
    content: f.content,
    storedAtMs: f.storedAtMs,
  }));
  const { active, supersededIds } = applySupersession(rows);

  const ordered = [...active].sort((a, b) => {
    if (b.storedAtMs !== a.storedAtMs) return b.storedAtMs - a.storedAtMs;
    const ka = factKey(a.content);
    const kb = factKey(b.content);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.content !== b.content) return a.content < b.content ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const lines: string[] = [];
  if (hardCap >= 1) {
    lines.push("# Startup Memory Map");
  }
  if (topics.length > 0 && lines.length + 1 <= hardCap && hardCap >= 3) {
    lines.push(`Topics: ${topics.join(", ")}`);
  }

  const remainingSlots = Math.max(0, hardCap - lines.length);
  let truncated = false;
  let includedFacts = 0;

  if (ordered.length <= remainingSlots) {
    for (const fact of ordered) {
      const singleLine = fact.content.replace(/\s+/g, " ").trim();
      lines.push(`- ${singleLine}`);
      includedFacts += 1;
    }
  } else if (remainingSlots > 0) {
    truncated = true;
    const factSlots = Math.max(0, remainingSlots - 1);
    for (let i = 0; i < factSlots; i += 1) {
      const singleLine = ordered[i]!.content.replace(/\s+/g, " ").trim();
      lines.push(`- ${singleLine}`);
      includedFacts += 1;
    }
    const omitted = ordered.length - includedFacts;
    lines.push(`<!-- +${omitted} more active fact(s) omitted (cap: ${hardCap} lines) -->`);
  } else if (ordered.length > 0) {
    truncated = true;
  }

  // Enforce hard cap invariant strictly.
  const finalLines = lines.slice(0, hardCap);
  const content = finalLines.join("\n");
  return {
    content,
    lineCount: finalLines.length,
    totalActiveFacts: ordered.length,
    includedFacts,
    supersededCount: supersededIds.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// 4-Phase Orchestrator (`runAutoDream`) + Non-Blocking Idle Hook (`maybeScheduleAutoDream`)
// ---------------------------------------------------------------------------

export interface AutoDreamRunOptions extends AutoDreamGateOptions {
  bank?: MemoryBankId;
  home?: string;
  /** Skip dual-gate elapsed/session thresholds (still respects HZ_AUTO_DREAM=0 unless ignoreEnv=true). */
  force?: boolean;
  /** Ignore HZ_AUTO_DREAM=0 (tests only). */
  ignoreEnv?: boolean;
  /** Inject turns instead of scanning session DB. */
  turns?: readonly SessionSignalTurn[];
  /** Inject tracked files instead of running `git ls-files`. */
  trackedFiles?: ReadonlySet<string>;
  trustTrackedSetOnly?: boolean;
  lockOptions?: AutoDreamLockOptions;
}

export interface AutoDreamRunResult {
  ran: boolean;
  skippedReason?: AutoDreamGateDecision["reason"] | "locked" | "unwritable";
  gate: AutoDreamGateDecision;
  lockHolderPid?: number;
  reclaimedStaleLock?: boolean;
  orientFactCount?: number;
  gatheredSignalCount?: number;
  deltas?: MemoryDelta[];
  applied?: ApplyMemoryDeltasResult;
  startupMap?: StartupMemoryMapResult;
}

/**
 * Execute the full 4-phase Auto-Dream consolidation under an exclusive lockfile.
 * Respects `HZ_AUTO_DREAM=0`, dual-gate thresholds, and `HZ_R170_SQLITE_BARRIER=1`.
 */
export function runAutoDream(
  workspace: string,
  opts: AutoDreamRunOptions = {},
): AutoDreamRunResult {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const env = opts.env ?? process.env;
  const gate = shouldRunAutoDream(workspace, { ...opts, nowMs, env });

  if (!opts.ignoreEnv && gate.reason === "disabled") {
    return { ran: false, skippedReason: "disabled", gate };
  }
  if (!opts.force && !gate.shouldRun) {
    return { ran: false, skippedReason: gate.reason, gate };
  }

  const lock = acquireAutoDreamLock(workspace, { nowMs, ...opts.lockOptions });
  if (!("release" in lock)) {
    return {
      ran: false,
      skippedReason: lock.reason,
      gate,
      lockHolderPid: lock.holderPid,
    };
  }

  try {
    // Phase 1: Orient
    const orient = orientMemory(workspace, { bank: opts.bank, home: opts.home });

    // Phase 2: Gather Signal
    const signals = gatherSessionSignal(workspace, {
      sinceMs: gate.lastDreamAtMs,
      turns: opts.turns,
    });

    // Phase 3: Consolidate (Itemized SQLite Deltas)
    const deltas = planMemoryDeltas(workspace, orient, signals, {
      nowIso,
      trackedFiles: opts.trackedFiles,
      trustTrackedSetOnly: opts.trustTrackedSetOnly,
    });
    const applied = applyMemoryDeltas(workspace, deltas, {
      bank: opts.bank,
      home: opts.home,
      nowIso,
    });

    // Phase 4: Prune & Index
    const startupMap = buildStartupMemoryMap(workspace, {
      bank: opts.bank,
      home: opts.home,
      topics: orient.topics,
    });

    writeAutoDreamState(workspace, {
      lastDreamAtMs: nowMs,
      lastDreamAtIso: nowIso,
      sessionsConsolidated: gate.sessionsSinceLastDream,
    });

    return {
      ran: true,
      gate,
      reclaimedStaleLock: lock.reclaimedStale,
      orientFactCount: orient.facts.length,
      gatheredSignalCount: signals.length,
      deltas,
      applied,
      startupMap,
    };
  } finally {
    lock.release();
  }
}

export interface AutoDreamScheduleOptions extends AutoDreamRunOptions {
  /** Idle delay before running in the background (default 1500ms). */
  delayMs?: number;
  onComplete?: (result: AutoDreamRunResult) => void;
  onError?: (error: unknown) => void;
}

export interface AutoDreamHandle {
  scheduled: boolean;
  cancel: () => void;
}

/**
 * Lightweight, strictly non-blocking idle hook for runtime startup/idle.
 * Zero startup-latency impact: uses an unref'd timer and respects `HZ_AUTO_DREAM=0`.
 */
export function maybeScheduleAutoDream(
  workspace: string,
  opts: AutoDreamScheduleOptions = {},
): AutoDreamHandle {
  const env = opts.env ?? process.env;
  if (!autoDreamEnabled(env)) {
    return { scheduled: false, cancel: () => {} };
  }
  const delayMs = Math.max(0, opts.delayMs ?? DEFAULT_IDLE_DELAY_MS);
  const timer = setTimeout(() => {
    try {
      const result = runAutoDream(workspace, opts);
      opts.onComplete?.(result);
    } catch (err) {
      opts.onError?.(err);
    }
  }, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    scheduled: true,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * dap/registry.ts — one live DAP adapter session per hzcode chat session.
 *
 * Launch/attach store the adapter here so step/stack/variables can reuse it
 * across tool calls (oh-my-pi keeps a session manager; this is the reduced form).
 * `close` / replace-on-relaunch dispose the child. Idle sessions are swept on
 * access (OMP session idle cleanup, reduced).
 */

import type { DapClient } from "./client";
import type { OwnedProc } from "../owned-spawn";

export interface LiveDapSession {
  client: DapClient;
  proc: OwnedProc;
  pump: Promise<void>;
  workspace: string;
  sessionId: string;
  /** Last activity (ms since epoch); used by idle sweep. */
  lastUsedAt: number;
  /** Close TCP/socket transport (stdio sessions omit this). */
  transportClose?: () => void;
  /** Last launched program command line (for step admission / messages). */
  program?: string;
  /** Last attach target label. */
  attachTarget?: string;
}

const sessions = new Map<string, LiveDapSession>();

/** Which live session is "focused" for tools that omit an explicit session id. */
let focusedKey: string | undefined;

/** Default idle TTL (30 minutes). Override with `HZ_DAP_IDLE_MS` (min 5s). */
export const DEFAULT_DAP_IDLE_MS = 30 * 60 * 1000;

export function dapIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HZ_DAP_IDLE_MS;
  if (raw === undefined || raw === "") return DEFAULT_DAP_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000) return DEFAULT_DAP_IDLE_MS;
  return Math.floor(n);
}

export function dapSessionKey(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

export function getLiveDapSession(workspace: string, sessionId: string): LiveDapSession | undefined {
  const live = sessions.get(dapSessionKey(workspace, sessionId));
  if (live) {
    live.lastUsedAt = Date.now();
    focusedKey = dapSessionKey(workspace, sessionId);
  }
  return live;
}

export function setLiveDapSession(session: LiveDapSession): void {
  session.lastUsedAt = Date.now();
  const key = dapSessionKey(session.workspace, session.sessionId);
  sessions.set(key, session);
  focusedKey = key;
}

/** The most recently used live session (set/get), if any. */
export function getFocusedDapSession(): LiveDapSession | undefined {
  if (focusedKey === undefined) return undefined;
  const live = sessions.get(focusedKey);
  if (!live) {
    focusedKey = undefined;
    return undefined;
  }
  live.lastUsedAt = Date.now();
  return live;
}

export function clearDapFocus(): void {
  focusedKey = undefined;
}

async function killProc(proc: OwnedProc): Promise<void> {
  try {
    (proc.stdin as unknown as { end?: () => void })?.end?.();
  } catch {
    /* ignore */
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

async function teardown(live: LiveDapSession): Promise<void> {
  try {
    live.transportClose?.();
  } catch {
    /* ignore */
  }
  await killProc(live.proc);
  await live.pump.catch(() => undefined);
}

/** Dispose one live session (idempotent). */
export async function disposeLiveDapSession(workspace: string, sessionId: string): Promise<boolean> {
  const key = dapSessionKey(workspace, sessionId);
  const live = sessions.get(key);
  if (!live) return false;
  sessions.delete(key);
  if (focusedKey === key) focusedKey = undefined;
  await teardown(live);
  return true;
}

/**
 * Dispose live adapters idle longer than `maxIdleMs` (default from `HZ_DAP_IDLE_MS`).
 * Returns how many sessions were closed.
 */
export async function sweepIdleDapSessions(
  maxIdleMs: number = dapIdleMs(),
  now: number = Date.now(),
): Promise<number> {
  let closed = 0;
  for (const [key, live] of [...sessions.entries()]) {
    if (now - live.lastUsedAt < maxIdleMs) continue;
    sessions.delete(key);
    if (focusedKey === key) focusedKey = undefined;
    await teardown(live);
    closed += 1;
  }
  return closed;
}

/** Test helper: drop every live adapter. */
export async function disposeAllLiveDapSessions(): Promise<void> {
  const keys = [...sessions.keys()];
  focusedKey = undefined;
  for (const key of keys) {
    const live = sessions.get(key);
    if (!live) continue;
    sessions.delete(key);
    await teardown(live);
  }
}

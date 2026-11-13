/**
 * F4 reduced: portable session archive (`.hzs` JSON v1).
 *
 * Export-only slice: manifest + transcript + per-session checkpoints + receipt
 * chain head. No import, no id remapping, no kernel log.verify — those need
 * docs/11 E6 trust work before foreign sessions may resume.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg } from "../contracts";
import { type CheckpointRecord, listCheckpoints } from "./checkpoints";
import { maskSecrets } from "./compaction";
import { receiptHead } from "./convo";
import { sanitizeStream } from "./kernel";
import { kernelStateDir, stateRoot } from "./paths";
import { type SessionInfo, SessionStore } from "./session";

/** Manifest version for `format: "hzs-json-v1"`. */
export const HZS_MANIFEST_VERSION = 1 as const;

export interface HzsChainHeads {
  receipts?: string;
}

export interface HzsManifest {
  version: typeof HZS_MANIFEST_VERSION;
  format: "hzs-json-v1";
  sessionId: string;
  title: string;
  exportedAt: string;
  chainHeads: HzsChainHeads;
  /** What this file contains (honest scope). */
  includes: {
    messages: true;
    checkpoints: true;
    sessionEvents: boolean;
    eventsTruncated?: boolean;
  };
}

export interface SessionArchiveV1 {
  manifest: HzsManifest;
  session: SessionInfo;
  messages: ChatMsg[];
  checkpoints: CheckpointRecord[];
  /** Present when the session event log exists; capped by `maxEvents`. */
  events?: unknown[];
}

const DEFAULT_MAX_EVENTS = 4000;

function readSessionEventLines(workspace: string, sessionId: string, maxLines: number): { events: unknown[]; truncated: boolean } {
  const rel = `${sanitizeStream(`session:${sessionId}`)}.jsonl`;
  const file = path.join(kernelStateDir(workspace), "events", rel);
  let truncated = false;
  const events: unknown[] = [];
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    let kept = 0;
    for (const line of lines) {
      const text = line.trim();
      if (text === "") continue;
      if (kept >= maxLines) {
        truncated = true;
        break;
      }
      try {
        events.push(JSON.parse(text) as unknown);
        kept += 1;
      } catch {
        /* skip corrupt line — verify is import-time work */
      }
    }
  } catch {
    return { events: [], truncated: false };
  }
  return { events, truncated };
}

/** Build the archive payload (pure aside from store/checkpoint reads). */
export function buildSessionArchive(
  workspace: string,
  sessionId: string,
  opts: { exportedAt?: string; maxEvents?: number; includeEvents?: boolean } = {},
): SessionArchiveV1 {
  const store = new SessionStore(workspace);
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`no session ${sessionId} in this workspace`);
  const messages = store.history(sessionId);
  const cpLoad = listCheckpoints(workspace);
  const checkpoints = cpLoad.checkpoints.filter((c) => c.sessionId === sessionId);
  const exportedAt = opts.exportedAt ?? new Date().toISOString();
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const includeEvents = opts.includeEvents !== false;
  const eventRead = includeEvents ? readSessionEventLines(workspace, sessionId, maxEvents) : { events: [], truncated: false };

  return {
    manifest: {
      version: HZS_MANIFEST_VERSION,
      format: "hzs-json-v1",
      sessionId: session.id,
      title: session.title,
      exportedAt,
      chainHeads: { receipts: receiptHead(kernelStateDir(workspace)) },
      includes: {
        messages: true,
        checkpoints: true,
        sessionEvents: eventRead.events.length > 0,
        ...(eventRead.truncated ? { eventsTruncated: true } : {}),
      },
    },
    session,
    messages,
    checkpoints,
    ...(eventRead.events.length > 0 ? { events: eventRead.events } : {}),
  };
}

export function renderHzsArchive(archive: SessionArchiveV1): string {
  return JSON.stringify(archive, null, 2) + "\n";
}

export function defaultHzsExportPath(workspace: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateRoot(workspace), "exports", `${safe}.hzs`);
}

/** Write `.hzs` under `<state>/exports/` unless `outPath` is set. */
export function writeSessionArchive(
  workspace: string,
  sessionId: string,
  outPath?: string,
): { path: string; messageCount: number; checkpointCount: number; eventCount: number } {
  const archive = buildSessionArchive(workspace, sessionId);
  const target = outPath ?? defaultHzsExportPath(workspace, sessionId);
  mkdirSync(path.dirname(target), { recursive: true });
  const body = maskSecrets(renderHzsArchive(archive));
  writeFileSync(target, body, { mode: 0o600 });
  return {
    path: target,
    messageCount: archive.messages.length,
    checkpointCount: archive.checkpoints.length,
    eventCount: archive.events?.length ?? 0,
  };
}

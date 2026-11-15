/**
 * hook-handoff-capture.ts — per-session hook audit ring for handoff_create (§8 #3).
 *
 * Records compact lines from `hook.decision` / `hook.failure` durable events so
 * handoffs can carry hook lifecycle without a `todos` section. When the in-memory
 * ring is empty, replays the same types from the session events JSONL.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sanitizeStream } from "./kernel";
import { kernelStateDir } from "./paths";

const CAP_PER_SESSION = 32;
const JSONL_TAIL_BYTES = 512_000;

const STORE = new Map<string, string[]>();

function lines(sessionId: string): string[] {
  let list = STORE.get(sessionId);
  if (!list) {
    list = [];
    STORE.set(sessionId, list);
  }
  return list;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

export function formatHookAuditLine(type: string, payload: unknown): string | null {
  const p = payloadRecord(payload);
  const tool = typeof p.tool === "string" ? p.tool : "?";
  const hook = typeof p.hook === "string" ? p.hook : "?";
  if (type === "hook.failure") {
    const err = typeof p.error === "string" ? p.error.trim() : "failed";
    return `[failure] ${tool} via ${hook}: ${err}`;
  }
  const decision = typeof p.decision === "string" ? p.decision : "unknown";
  if (decision === "deny") {
    const reason = typeof p.reason === "string" && p.reason !== "" ? p.reason : "denied";
    return `[deny] ${tool} via ${hook}: ${reason}`;
  }
  if (decision === "observe") {
    const bytes = typeof p.contextBytes === "number" ? p.contextBytes : 0;
    const tr = p.truncated === true ? " (truncated)" : "";
    return `[observe] ${tool} via ${hook}: context ${bytes} bytes${tr}`;
  }
  if (decision === "allow") {
    return `[allow] ${tool} via ${hook}`;
  }
  return `[${decision}] ${tool} via ${hook}`;
}

/** Append one audit line when the loop logs hook.* events. */
export function recordHookAuditLine(sessionId: string, type: string, payload: unknown): void {
  if (sessionId.trim() === "") return;
  if (type !== "hook.decision" && type !== "hook.failure") return;
  const line = formatHookAuditLine(type, payload);
  if (line === null) return;
  const list = lines(sessionId);
  list.push(line);
  if (list.length > CAP_PER_SESSION) list.splice(0, list.length - CAP_PER_SESSION);
}

function sessionEventLogPath(workspace: string, sessionId: string): string {
  const stream = `session:${sessionId}`;
  const file = `${sanitizeStream(stream)}.jsonl`;
  return path.join(kernelStateDir(workspace), "events", file);
}

/** Replay hook audit lines from durable session events (newest last). */
export function hookAuditLinesFromSessionJsonl(workspace: string, sessionId: string, max = CAP_PER_SESSION): string[] {
  const logPath = sessionEventLogPath(workspace, sessionId);
  if (!existsSync(logPath)) return [];
  try {
    const buf = readFileSync(logPath);
    const tail = buf.length > JSONL_TAIL_BYTES ? buf.subarray(buf.length - JSONL_TAIL_BYTES) : buf;
    const text = tail.toString("utf8");
    const lines: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      try {
        const row = JSON.parse(line) as { type?: string; payload?: unknown };
        if (row.type !== "hook.decision" && row.type !== "hook.failure") continue;
        const formatted = formatHookAuditLine(row.type, row.payload);
        if (formatted !== null) lines.push(formatted);
      } catch {
        /* skip corrupt tail fragments */
      }
    }
    return lines.slice(-Math.max(1, Math.min(max, CAP_PER_SESSION)));
  } catch {
    return [];
  }
}

function mergeHookAuditLines(ring: string[], jsonl: string[], max = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...jsonl, ...ring]) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.slice(-Math.max(1, Math.min(max, CAP_PER_SESSION)));
}

/** Newest-last snapshot for handoff context (default cap 16). */
export function recentHookAuditLines(sessionId: string, workspace?: string, max = 16): string[] {
  const ring = STORE.get(sessionId) ?? [];
  const take = Math.max(1, Math.min(max, CAP_PER_SESSION));
  if (ring.length === 0 && workspace !== undefined && workspace.trim() !== "") {
    return hookAuditLinesFromSessionJsonl(workspace, sessionId, take);
  }
  if (workspace !== undefined && workspace.trim() !== "") {
    const jsonl = hookAuditLinesFromSessionJsonl(workspace, sessionId, take);
    if (jsonl.length > 0) return mergeHookAuditLines(ring.slice(-take), jsonl, take);
  }
  if (ring.length === 0) return [];
  return ring.slice(-take);
}

export function hookAuditBlockForHandoff(sessionId: string, workspace?: string): string {
  const recent = recentHookAuditLines(sessionId, workspace);
  if (recent.length === 0) return "";
  const source = workspace !== undefined ? "Hook audit (session ring + events log):" : "Hook audit (this session):";
  return [source, ...recent.map((l) => `- ${l}`)].join("\n");
}

/** Test isolation. */
export function resetHookAuditForTests(): void {
  STORE.clear();
}
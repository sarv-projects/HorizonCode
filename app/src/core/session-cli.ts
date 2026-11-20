/**
 * F3 reduced: `hzcode session list|fork|export` thin wrappers over SessionStore.
 */

import * as path from "node:path";
import { defaultHzsExportPath, writeSessionArchiveGuarded } from "./archive";
import { metricContract } from "./metrics";
import { meetPermissionMode, type PermissionMode } from "./permission-mode";
import { SessionStore } from "./session";

/** H-7: contracted form of the session-export success counts (ruling 570). */
export function sessionExportPublication(input: {
  messageCount: number;
  checkpointCount: number;
  eventCount: number;
}): string[] {
  const anchor = "none — this session-export invocation";
  const population = "messages/checkpoints/events included in the written .hzs archive";
  const excludes = "none — counts are the archive payload sizes after maskSecrets";
  return [
    metricContract({
      metric: "session export messages",
      anchor,
      population,
      excludes,
      value: input.messageCount,
    }),
    metricContract({
      metric: "session export checkpoints",
      anchor,
      population,
      excludes,
      value: input.checkpointCount,
    }),
    metricContract({
      metric: "session export events",
      anchor,
      population,
      excludes,
      value: input.eventCount,
    }),
  ];
}

/** H-7: contracted form of TUI `/export` json/html message count (ruling 574). */
export function convoExportPublication(input: { messageCount: number; format: "json" | "html" }): string[] {
  return [
    metricContract({
      metric: "convo export messages",
      anchor: "none — this TUI /export invocation",
      population: `messages included in the written ${input.format} export`,
      excludes: "none — count is history length at export time",
      value: input.messageCount,
    }),
  ];
}


/** H-7: contracted form of `hzcode session fork` message index (ruling 608). */
export function sessionForkPublication(input: { messageIndex: number }): string[] {
  return [
    metricContract({
      metric: "session fork message index",
      anchor: "none — this session-fork invocation",
      population: "message index at which the child session was forked from the parent",
      excludes: "none — the printed at-message index is the sole scalar",
      value: input.messageIndex,
    }),
  ];
}

/** H-7: contracted form of `hzcode session list` row count (ruling 590). */
export function sessionListPublication(input: { listed: number; limit: number }): string[] {
  const anchor = "none — this session-list invocation";
  const population = "sessions returned by SessionStore.listSessions for the requested limit";
  const excludes = "none — count is the listed page size (not total historical sessions beyond limit)";
  return [
    metricContract({
      metric: "session list rows",
      anchor,
      population,
      excludes,
      value: input.listed,
    }),
    metricContract({
      metric: "session list limit",
      anchor,
      population,
      excludes,
      value: input.limit,
    }),
  ];
}

export function listSessionsPage(workspace: string, limit = 20): { rows: ReturnType<SessionStore["listSessions"]>; limit: number } {
  const capped = Math.max(1, limit);
  const store = new SessionStore(workspace);
  return { rows: store.listSessions(capped), limit: capped };
}

export function formatSessionList(rows: ReturnType<SessionStore["listSessions"]>): string {
  if (rows.length === 0) return "no sessions in this workspace";
  const lines = [`sessions (newest first, ${rows.length}):`];
  for (const s of rows) {
    const fork =
      s.forkedFrom !== undefined ? ` fork@${s.forkedFrom.messageIndex} from ${s.forkedFrom.sessionId.slice(0, 8)}` : "";
    lines.push(`  ${s.id}  ${s.title}${fork}`);
  }
  lines.push("", "resume: hzcode --resume <id>");
  return lines.join("\n");
}

export function renderSessionList(workspace: string, limit = 20): string {
  return formatSessionList(listSessionsPage(workspace, limit).rows);
}

/**
 * Export a session archive after Guard `fs.write` on the destination
 * (rulings 569/621). Deny/ask refuse before any bytes are written.
 */
export async function exportSessionCli(
  workspace: string,
  sessionId: string,
  opts: { out?: string } = {},
): Promise<{ path: string; messageCount: number; checkpointCount: number; eventCount: number }> {
  const out = opts.out !== undefined ? path.resolve(opts.out) : defaultHzsExportPath(workspace, sessionId);
  try {
    return await writeSessionArchiveGuarded(workspace, sessionId, out);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/requires approval/i.test(detail)) {
      throw new Error(
        "session export refused: unattended export never self-approves; allow the path in policy or pass an allowed -o path",
      );
    }
    if (/denied/i.test(detail)) {
      throw new Error(`session export refused: denied by policy: ${detail}`);
    }
    throw new Error(`session export refused: ${detail}`);
  }
}

export function forkSessionCli(
  workspace: string,
  parentId: string,
  opts: { at?: number; permissionMode?: PermissionMode } = {},
): { childId: string; title: string; messageIndex: number; permissionMode?: PermissionMode } {
  const store = new SessionStore(workspace);
  const parent = store.getSession(parentId);
  if (!parent) throw new Error(`no session ${parentId} in this workspace`);
  const childMode = meetPermissionMode(parent.permissionMode, opts.permissionMode);
  const child = store.forkSession(parentId, { at: opts.at, permissionMode: childMode });
  return {
    childId: child.id,
    title: child.title,
    messageIndex: child.forkedFrom?.messageIndex ?? 0,
    permissionMode: child.permissionMode,
  };
}

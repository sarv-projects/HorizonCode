/**
 * F3 reduced: `hzcode session list|fork|export` thin wrappers over SessionStore.
 */

import * as path from "node:path";
import { writeSessionArchive } from "./archive";
import { meetPermissionMode, type PermissionMode } from "./permission-mode";
import { SessionStore } from "./session";

export function renderSessionList(workspace: string, limit = 20): string {
  const store = new SessionStore(workspace);
  const rows = store.listSessions(Math.max(1, limit));
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

export function exportSessionCli(
  workspace: string,
  sessionId: string,
  opts: { out?: string } = {},
): { path: string; messageCount: number; checkpointCount: number; eventCount: number } {
  const out = opts.out !== undefined ? path.resolve(opts.out) : undefined;
  return writeSessionArchive(workspace, sessionId, out);
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

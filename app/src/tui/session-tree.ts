/**
 * session-tree.ts — indented fork tree for /sessions tree (docs/13 D13 reduced).
 */

import type { SessionInfo } from "../core/session";

export function buildSessionTree(sessions: readonly SessionInfo[], currentId?: string): string[] {
  const byParent = new Map<string | undefined, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.forkedFrom?.sessionId;
    const list = byParent.get(key) ?? [];
    list.push(s);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.updated.localeCompare(b.updated));
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, prefix: string): void => {
    const children = byParent.get(parent) ?? [];
    for (let i = 0; i < children.length; i += 1) {
      const s = children[i]!;
      const last = i === children.length - 1;
      const branch = last ? "└─ " : "├─ ";
      const mark = s.id === currentId ? "* " : "";
      const lineage =
        s.forkedFrom !== undefined ? ` (fork @ msg ${s.forkedFrom.messageIndex})` : "";
      lines.push(`${prefix}${branch}${mark}${s.id}  ${s.title}${lineage}`);
      walk(s.id, prefix + (last ? "   " : "│  "));
    }
  };
  walk(undefined, "");
  if (lines.length === 0) lines.push("(no sessions)");
  return lines;
}

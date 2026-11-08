/**
 * change-journal.ts -- the session's undo record.
 *
 * Every successful `write`/`edit` appends one entry: the resolved path, the
 * content as it was *before* the change (`null` when the file did not exist),
 * and the sha256 of the content the change produced. `undo` walks the list
 * backwards from the most recent entry.
 *
 * Scope, named honestly: the journal is in-memory and session-scoped. It
 * survives every change inside a run, not a process restart -- durable change
 * history belongs in the kernel receipt chain (each tool call already issues a
 * receipt), and until that exists an in-session undo is the half worth having:
 * the common case is "the model broke this two steps ago", not "yesterday".
 */

export interface ChangeEntry {
  /** Absolute resolved path (what the effect landed on). */
  path: string;
  /** Workspace-relative path, for messages. */
  rel: string;
  /** Content before the change; null = the file did not exist. */
  before: string | null;
  /** Existed, but its bytes are not restorable text (binary / not UTF-8). */
  beforeUnreadable?: boolean;
  /** sha256 of the content this change wrote -- the undo stale-check. */
  afterSha256: string;
  at: number;
  tool: "write" | "edit";
}

/** Bounded so a long session cannot grow without limit; oldest entries drop. */
export const MAX_JOURNAL_ENTRIES = 50;

const JOURNALS = new Map<string, ChangeEntry[]>();

export function recordChange(sessionId: string, entry: ChangeEntry): void {
  const list = JOURNALS.get(sessionId) ?? [];
  list.push(entry);
  while (list.length > MAX_JOURNAL_ENTRIES) list.shift();
  JOURNALS.set(sessionId, list);
}

/** The most recent recorded change in the session, if any. */
export function lastChange(sessionId: string): ChangeEntry | undefined {
  return JOURNALS.get(sessionId)?.at(-1);
}

/** The most recent recorded change to one resolved path. */
export function lastChangeFor(sessionId: string, resolved: string): ChangeEntry | undefined {
  const list = JOURNALS.get(sessionId);
  if (list === undefined) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i] as ChangeEntry;
    if (e.path === resolved) return e;
  }
  return undefined;
}

/** Remove one entry (undo consumed it). Returns false if it was already gone. */
export function consumeChange(sessionId: string, entry: ChangeEntry): boolean {
  const list = JOURNALS.get(sessionId);
  if (list === undefined) return false;
  const i = list.indexOf(entry);
  if (i === -1) return false;
  list.splice(i, 1);
  return true;
}

/** For tests and diagnostics. */
export function journalSize(sessionId: string): number {
  return JOURNALS.get(sessionId)?.length ?? 0;
}

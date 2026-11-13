/**
 * composer-draft.ts — stash composer text aborted mid-turn (docs/13 D16 partial).
 *
 * Persists one draft per session under the workspace state root; restored once
 * when the next idle prompt is empty.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "../core/paths";

const VERSION = 1 as const;

interface ComposerDraftFile {
  version: typeof VERSION;
  sessionId: string;
  draft: string;
  savedAt: string;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function draftPath(workspace: string, sessionId: string): string {
  return path.join(stateRoot(workspace), `composer-aborted-draft-${safeSessionId(sessionId)}.json`);
}

export function saveAbortedComposerDraft(workspace: string, sessionId: string, draft: string): void {
  const text = draft.trimEnd();
  if (text === "") return;
  const dir = stateRoot(workspace);
  mkdirSync(dir, { recursive: true });
  const target = draftPath(workspace, sessionId);
  const payload: ComposerDraftFile = {
    version: VERSION,
    sessionId,
    draft: text,
    savedAt: new Date().toISOString(),
  };
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload) + "\n", { mode: 0o600, encoding: "utf8" });
  renameSync(tmp, target);
}

/** Read and delete the stashed draft (one-shot). */
export function takeAbortedComposerDraft(workspace: string, sessionId: string): string | undefined {
  const target = draftPath(workspace, sessionId);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
  try {
    unlinkSync(target);
  } catch {
    /* best effort */
  }
  try {
    const parsed = JSON.parse(raw) as ComposerDraftFile;
    if (parsed?.version !== VERSION) return undefined;
    if (parsed.sessionId !== sessionId || typeof parsed.draft !== "string") return undefined;
    return parsed.draft;
  } catch {
    return undefined;
  }
}

export function clearAbortedComposerDraft(workspace: string, sessionId: string): void {
  try {
    unlinkSync(draftPath(workspace, sessionId));
  } catch {
    /* none */
  }
}

/**
 * handoff.ts — TUI relaunch state (docs/13 D2).
 *
 * Atomic write to `<workspace state>/tui-handoff.json`, consumed once on the
 * next process start. Does not re-admit prompts or mint a new session.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "../core/paths";
import type { TuiScreenMode } from "./screen-mode";

export interface TuiHandoff {
  version: 1;
  sessionId: string;
  workspace: string;
  draft: string;
  mode: TuiScreenMode;
  eventCursor?: number;
  writtenAt: string;
}

const FILE = "tui-handoff.json";

function handoffPath(workspace: string): string {
  return path.join(stateRoot(workspace), FILE);
}

export function writeTuiHandoff(workspace: string, payload: Omit<TuiHandoff, "version" | "writtenAt">): void {
  const full: TuiHandoff = {
    version: 1,
    ...payload,
    writtenAt: new Date().toISOString(),
  };
  const dir = stateRoot(workspace);
  mkdirSync(dir, { recursive: true });
  const target = handoffPath(workspace);
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(full) + "\n", { mode: 0o600, encoding: "utf8" });
  renameSync(tmp, target);
}

/** Read and delete the handoff file (one-shot). */
export function consumeTuiHandoff(workspace: string): TuiHandoff | undefined {
  const target = handoffPath(workspace);
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
    const parsed = JSON.parse(raw) as TuiHandoff;
    if (parsed?.version !== 1) return undefined;
    if (typeof parsed.sessionId !== "string" || typeof parsed.draft !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

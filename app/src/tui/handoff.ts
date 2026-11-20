/**
 * handoff.ts — TUI relaunch state (docs/13 D2).
 *
 * Atomic write to `<workspace state>/tui-handoff.json`, consumed once on the
 * next process start. Does not re-admit prompts or mint a new session.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { metricContract } from "../core/metrics";
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

/**
 * Under-admission (ruling 588): Guard `fs.write` on `tui-handoff.json` before
 * materialising. Returns an error string on deny/ask/guard failure.
 */
export async function admitTuiHandoffWrite(workspace: string): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("../core/preds-writer");
  const refused = await admitPredsOutWrite(handoffPath(workspace), workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "tui-handoff refused:")
    .replace(/^preds write denied/, "tui-handoff denied")
    .replace(/^preds fs\.write requires approval/, "tui-handoff fs.write requires approval");
}

export async function writeTuiHandoff(
  workspace: string,
  payload: Omit<TuiHandoff, "version" | "writtenAt">,
): Promise<string | undefined> {
  const refused = await admitTuiHandoffWrite(workspace);
  if (refused !== undefined) return refused;
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
  return undefined;
}

/** H-7: contracted draft-byte count for `hzcode tui relaunch` (ruling 615). */
export function tuiRelaunchPublication(input: { draftBytes: number }): string[] {
  return [
    metricContract({
      metric: "tui relaunch draft bytes",
      anchor: "none — this tui relaunch consume",
      population: "UTF-16 code units in the consumed handoff draft string",
      excludes: "session id / mode / event cursor are not counted here",
      value: input.draftBytes,
    }),
  ];
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

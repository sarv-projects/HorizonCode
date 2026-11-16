/**
 * session-goal.ts — reduced per-session goal statement (ruling 453).
 *
 * Stored under `<stateRoot>/goals/<sessionId>.json`. Not the full goal engine
 * from docs/06; just enough for hz.goal.updated honesty.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "./paths";

export type SessionGoalStatus = "active" | "achieved" | "abandoned" | "blocked";

export type SessionGoal = {
  goalId: string;
  statement: string;
  status: SessionGoalStatus;
  revision: number;
  updatedAt: string;
};

function goalsDir(workspace: string): string {
  return path.join(stateRoot(workspace), "goals");
}

function goalPath(workspace: string, sessionId: string): string {
  return path.join(goalsDir(workspace), `${sessionId}.json`);
}

export function readSessionGoal(workspace: string, sessionId: string): SessionGoal | undefined {
  try {
    const raw = JSON.parse(readFileSync(goalPath(workspace, sessionId), "utf8")) as SessionGoal;
    if (typeof raw.statement !== "string" || typeof raw.goalId !== "string") return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function writeSessionGoal(
  workspace: string,
  sessionId: string,
  statement: string,
  status: SessionGoalStatus = "active",
): SessionGoal {
  const trimmed = statement.replace(/\s+/g, " ").trim().slice(0, 500);
  if (trimmed === "") throw new Error("goal statement is required");
  const prev = readSessionGoal(workspace, sessionId);
  const next: SessionGoal = {
    goalId: prev?.goalId ?? `goal_${sessionId.slice(0, 8)}`,
    statement: trimmed,
    status,
    revision: (prev?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(goalsDir(workspace), { recursive: true });
  writeFileSync(goalPath(workspace, sessionId), JSON.stringify(next) + "\n", { mode: 0o600 });
  return next;
}

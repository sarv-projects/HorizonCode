/**
 * task-board.ts -- task board view + advisory prompts (plan Task 25).
 *
 * Thin adapter over the shipped WIP gate: reuses `checkWorkspaceWip` and never
 * reimplements WIP=1/VCR/pass-state logic. Prompts are advisory text only and
 * never mark a feature as passed. No new authority, no guard/contract change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkWorkspaceWip, WIP_ENFORCER_FILE, type FeatureItem } from "./wip-enforcer";

export interface TaskBoard {
  ok: boolean;
  items: readonly FeatureItem[];
  violations: string[];
  activeCount: number;
}

const DEFAULT_MAX_CHARS = 4000;
const TRUNCATION_MARKER = "...[truncated]";

function readItems(workspace: string): FeatureItem[] {
  const file = path.join(workspace, WIP_ENFORCER_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed as FeatureItem[];
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { features?: unknown }).features)) {
      return (parsed as { features: FeatureItem[] }).features;
    }
  } catch {
    /* malformed JSON is already reported as a violation by the WIP gate */
  }
  return [];
}

export function loadTaskBoard(workspace: string): TaskBoard {
  const wip = checkWorkspaceWip(workspace);
  if (!wip.allowed) {
    return { ok: false, items: [], violations: wip.violations, activeCount: wip.activeCount };
  }
  // No feature list is not a violation: ok:true with an empty board.
  return { ok: true, items: readItems(workspace), violations: [], activeCount: wip.activeCount };
}

function bounded(text: string, maxChars: number): string {
  const cap = Math.max(1, Math.floor(maxChars));
  if (text.length <= cap) return text;
  if (cap <= TRUNCATION_MARKER.length) return text.slice(0, cap);
  return `${text.slice(0, cap - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function activeItem(board: TaskBoard): FeatureItem | undefined {
  return board.items.find((f) => f.status === "in_progress" || f.status === "active");
}

export function renderCoordinatorPrompt(board: TaskBoard, maxChars = DEFAULT_MAX_CHARS): string {
  const active = activeItem(board);
  const lines = [
    "COORDINATOR TASK BOARD (advisory)",
    `ok: ${board.ok}`,
    `activeCount: ${board.activeCount}`,
    active === undefined
      ? "active: none"
      : `active: ${active.id}${active.name === undefined ? "" : ` — ${active.name}`}`,
    ...board.violations.map((v) => `- ${v}`),
  ];
  return bounded(lines.join("\n"), maxChars);
}

export function renderCheckerPrompt(board: TaskBoard, maxChars = DEFAULT_MAX_CHARS): string {
  const active = activeItem(board);
  const lines = [
    "CHECKER VERIFICATION (advisory — never marks a feature passed)",
    "Required evidence: verification[] with the command run and observed output.",
    `ok: ${board.ok}`,
    active === undefined ? "review: none" : `review active item: ${active.id}`,
    ...board.violations.map((v) => `- ${v}`),
  ];
  return bounded(lines.join("\n"), maxChars);
}

/**
 * Single-key approval prompt context (rich TTY): initial card + optional live refresh
 * and optional 3-stage state transitions (`permission` -> `always_confirm` / `reject_steer`).
 */

import type { ApprovalStage, ApprovalStageState } from "./approval-card";

export type ApprovalKeyPromptObject = {
  lines: readonly string[];
  screenRows?: number;
  onTick?: () => readonly string[];
  /** Optional active stage for 3-stage approval prompts. */
  stage?: ApprovalStage;
  /** Optional renderer callback when a 3-stage prompt transitions stages or updates steering input. */
  renderStage?: (state: ApprovalStageState) => readonly string[];
};

export type ApprovalKeyPrompt = readonly string[] | ApprovalKeyPromptObject;

export const APPROVAL_GRANT_TICK_MS = 1000;

export function approvalCardScreenRows(lineCount: number): number {
  return Math.max(1, lineCount) + 1;
}

export function isApprovalKeyPromptObject(
  prompt: ApprovalKeyPrompt,
): prompt is ApprovalKeyPromptObject {
  return !Array.isArray(prompt);
}

export function normalizeApprovalKeyPrompt(prompt: ApprovalKeyPrompt): {
  lines: string[];
  screenRows: number;
  onTick?: () => string[];
  stage?: ApprovalStage;
  renderStage?: (state: ApprovalStageState) => string[];
} {
  if (Array.isArray(prompt)) {
    const lines = [...prompt];
    return { lines, screenRows: approvalCardScreenRows(lines.length) };
  }
  const obj = prompt as ApprovalKeyPromptObject;
  const lines = [...obj.lines];
  const screenRows = obj.screenRows ?? approvalCardScreenRows(lines.length);
  const tick = obj.onTick;
  const onTick = tick ? () => [...tick()] : undefined;
  const render = obj.renderStage;
  const renderStage = render ? (state: ApprovalStageState) => [...render(state)] : undefined;
  return { lines, screenRows, onTick, stage: obj.stage, renderStage };
}

/** Erase `screenRows` above the cursor and rewrite the approval card block. */
export function refreshApprovalCardAboveCursor(
  write: (chunk: string) => void,
  screenRows: number,
  lines: string[],
): void {
  if (screenRows <= 0 || lines.length === 0) return;
  write(`\x1b[${screenRows}A`);
  for (const line of lines) {
    write(`\x1b[2K\r${line}\n`);
  }
  write("\x1b[2K\r\n\x1b[J");
}
/**
 * guard-prompt.ts — one prompt file per failure class (docs/30 C-10 reduced).
 *
 * Each soft nudge is loaded from `prompts/guards/` and wrapped in
 * `<system-interrupt reason="…">`.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const PROMPT_DIR = path.join(import.meta.dir, "..", "prompts", "guards");

export type GuardPromptId =
  | "tool-call-loop"
  | "action-stationarity"
  | "consecutive-mistakes"
  | "format-errors"
  | "context-overflow"
  | "thinking-loop"
  | "repeated-tool-error"
  | "budget-exhaustion";

const PROMPT_FILES: Record<GuardPromptId, string> = {
  "tool-call-loop": "tool-call-loop.md",
  "action-stationarity": "action-stationarity.md",
  "consecutive-mistakes": "consecutive-mistakes.md",
  "format-errors": "format-errors.md",
  "context-overflow": "context-overflow.md",
  "thinking-loop": "thinking-loop.md",
  "repeated-tool-error": "repeated-tool-error.md",
  "budget-exhaustion": "budget-exhaustion.md",
};

export function wrapSystemInterrupt(reason: string, body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  return `<system-interrupt reason="${reason}">\n${trimmed}\n</system-interrupt>`;
}

/** Load a guard prompt template from disk (tests may rely on the bundled file). */
export function loadGuardPrompt(id: GuardPromptId): string {
  const file = path.join(PROMPT_DIR, PROMPT_FILES[id]);
  return readFileSync(file, "utf8");
}

/**
 * Build the loop-detection soft nudge: template + dynamic detail, system-interrupt wrapped.
 */
export function loopDetectionInterruptNudge(toolLabel: string, count: number): string {
  const template = loadGuardPrompt("tool-call-loop");
  const body = template.replaceAll("{tool}", toolLabel).replaceAll("{count}", String(count));
  return wrapSystemInterrupt("tool_call_loop", body);
}

export function actionStationarityInterruptNudge(toolLabel: string, count: number): string {
  const template = loadGuardPrompt("action-stationarity");
  const body = template.replaceAll("{tool}", toolLabel).replaceAll("{count}", String(count));
  return wrapSystemInterrupt("action_stationarity", body);
}

export function consecutiveMistakesInterruptNudge(count: number, max: number): string {
  const template = loadGuardPrompt("consecutive-mistakes");
  const body = template.replaceAll("{count}", String(count)).replaceAll("{max}", String(max));
  return wrapSystemInterrupt("consecutive_mistakes", body);
}

export function formatErrorsInterruptNudge(count: number, max: number): string {
  const template = loadGuardPrompt("format-errors");
  const body = template.replaceAll("{count}", String(count)).replaceAll("{max}", String(max));
  return wrapSystemInterrupt("format_errors", body);
}

/** Soft nudge after CONTEXT_WINDOW_EXCEEDED emergency compaction (C-10). */
export function contextOverflowInterruptNudge(): string {
  const body = loadGuardPrompt("context-overflow");
  return wrapSystemInterrupt("context_overflow", body);
}

/** Soft nudge after a repeated thinking / no-tool stall (C-10). */
export function thinkingLoopInterruptNudge(): string {
  const body = loadGuardPrompt("thinking-loop");
  return wrapSystemInterrupt("thinking_loop", body);
}

/** Soft nudge after repeated tool-call failures (C-10 / ruling 491). */
export function repeatedToolErrorInterruptNudge(count: number, max: number): string {
  const template = loadGuardPrompt("repeated-tool-error");
  const body = template.replaceAll("{count}", String(count)).replaceAll("{max}", String(max));
  return wrapSystemInterrupt("repeated_tool_error", body);
}

/** Soft nudge when the run budget is nearly exhausted (C-10 / ruling 491). */
export function budgetExhaustionInterruptNudge(remaining: string): string {
  const template = loadGuardPrompt("budget-exhaustion");
  const body = template.replaceAll("{remaining}", remaining);
  return wrapSystemInterrupt("budget_exhaustion", body);
}

/**
 * guard-prompt.ts — one prompt file per failure class (docs/30 C-10 reduced).
 *
 * v1 ships `tool-call-loop` only, wrapped in `<system-interrupt reason="…">`.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const PROMPT_DIR = path.join(import.meta.dir, "..", "prompts", "guards");

export type GuardPromptId = "tool-call-loop" | "consecutive-mistakes";

const PROMPT_FILES: Record<GuardPromptId, string> = {
  "tool-call-loop": "tool-call-loop.md",
  "consecutive-mistakes": "consecutive-mistakes.md",
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

export function consecutiveMistakesInterruptNudge(count: number, max: number): string {
  const template = loadGuardPrompt("consecutive-mistakes");
  const body = template.replaceAll("{count}", String(count)).replaceAll("{max}", String(max));
  return wrapSystemInterrupt("consecutive_mistakes", body);
}

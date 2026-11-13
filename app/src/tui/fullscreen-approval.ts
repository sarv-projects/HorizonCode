/**
 * fullscreen-approval.ts — rich vs line guard prompts in alt-screen (docs/33 §5.17).
 *
 * Pure helpers: fullscreen reuses `approval-card.ts` + `keyChoice` when colour TTY
 * and raw keypress are available; otherwise the line prompt via `ui.ask` (fail closed).
 */

import { keyChoice, type KeyAnswer } from "./approval-card";
import { colorEnabled } from "./style";

export const APPROVAL_TYPE_AHEAD_MS = 250;

/** Same contract as scrollback `liveOn && canEsc` (ruling 85), injectable for tests. */
export function fullscreenRichApprovalEnabled(
  input: { isTty?: boolean; canRawMode?: boolean },
  env: Record<string, string | undefined> = process.env,
  colorOn: () => boolean = colorEnabled,
): boolean {
  if (input.isTty === false) return false;
  if (input.canRawMode === false) return false;
  if (!input.isTty) return false;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb" || env.TERM === "unknown") return false;
  return colorOn();
}

export function fullscreenApprovalStatusExtra(mode: "key" | "line"): string {
  return mode === "key" ? "approval: y/n/a/Esc" : "approval: y/n/a + Enter";
}

export type FullscreenApprovalKeyOutcome = KeyAnswer | "ignore" | "paste-block";

/** One keypress while the bordered card is armed (type-ahead + paste guards). */
export function consumeFullscreenApprovalKey(
  armedAt: number,
  now: number,
  pasting: boolean,
  key: { name?: string; ctrl?: boolean } | undefined,
  str: string | undefined,
): FullscreenApprovalKeyOutcome {
  if (pasting || key?.name === "paste-start" || key?.name === "paste-end") return "paste-block";
  if (now < armedAt) return "ignore";
  const choice = keyChoice(str, key);
  return choice ?? "ignore";
}

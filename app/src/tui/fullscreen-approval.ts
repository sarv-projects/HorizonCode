/**
 * fullscreen-approval.ts — rich vs line guard prompts in alt-screen (docs/33 §5.17).
 *
 * Pure helpers: fullscreen reuses `approval-card.ts` + `keyChoice` when colour TTY
 * and raw keypress are available; otherwise the line prompt via `ui.ask` (fail closed).
 */

import {
  createApprovalStageState,
  keyChoice,
  reduceApprovalStageKey,
  type ApprovalStage,
  type ApprovalStageResolution,
  type ApprovalStageState,
  type KeyAnswer,
} from "./approval-card";
import { colorEnabled, strip } from "./style";

export { createApprovalStageState, reduceApprovalStageKey, type ApprovalStage, type ApprovalStageResolution, type ApprovalStageState };

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

/** Status-line grant countdown while a key approval waits (from card footnote). */
export function approvalGrantStatusFromCardLines(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const plain = strip(line);
    const idx = plain.indexOf("session grant:");
    if (idx >= 0) {
      const tail = plain.slice(idx + "session grant:".length).trim();
      return tail !== "" ? `grant: ${tail}` : undefined;
    }
  }
  return undefined;
}

/** Locate approval card lines already appended to the fullscreen transcript. */
export function findApprovalCardTranscriptStart(transcript: readonly string[], lines: readonly string[]): number {
  if (lines.length === 0) return transcript.length;
  const needle = strip(lines[0] ?? "");
  if (needle === "") return Math.max(0, transcript.length - lines.length);
  const searchFrom = Math.max(0, transcript.length - lines.length - 6);
  for (let i = transcript.length - 1; i >= searchFrom; i -= 1) {
    const row = transcript[i] ?? "";
    if (strip(row) === needle || row.includes(needle)) return i;
  }
  return Math.max(0, transcript.length - lines.length);
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

/** Status-line hint for each stage of the 3-stage fullscreen approval prompt. */
export function fullscreenApprovalStageStatusExtra(stage: ApprovalStage): string {
  if (stage === "always_confirm") {
    return "confirm always: Enter/y confirm \u00b7 Esc/n back";
  }
  if (stage === "reject_steer") {
    return "reject & steer: type instruction + Enter \u00b7 Esc back";
  }
  return "approval: y once \u00b7 a always \u00b7 n reject \u00b7 Esc deny";
}

export type FullscreenStagedApprovalOutcome =
  | { readonly kind: "ignore" }
  | { readonly kind: "paste-block" }
  | { readonly kind: "transition"; readonly state: ApprovalStageState }
  | {
      readonly kind: "resolved";
      readonly state: ApprovalStageState;
      readonly resolution: ApprovalStageResolution;
    };

/**
 * Consume one keypress in the fullscreen 3-stage approval flow.
 * - Paste is blocked in Stage 1 (`permission`) and Stage 2 (`always_confirm`) so
 *   pasted "y"/"a" can never approve.
 * - Type-ahead (`now < armedAt`) is dropped on Stage 1.
 * - Stage 3 (`reject_steer`) accepts steering text, Enter to confirm (with or
 *   without steering), and Esc to return to Stage 1.
 */
export function consumeFullscreenStagedApprovalKey(
  state: ApprovalStageState,
  armedAt: number,
  now: number,
  pasting: boolean,
  key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
  str: string | undefined,
): FullscreenStagedApprovalOutcome {
  const isPasteMarker = key?.name === "paste-start" || key?.name === "paste-end";
  if (state.stage !== "reject_steer" && (pasting || isPasteMarker)) {
    return { kind: "paste-block" };
  }
  if (isPasteMarker) return { kind: "ignore" };
  if ((state.stage === "permission" || state.stage === "always_confirm") && now < armedAt) {
    return { kind: "ignore" };
  }
  if (state.stage === "reject_steer" && pasting) {
    const raw =
      typeof str === "string" && str.length > 0
        ? str
        : key?.name === "return" || key?.name === "enter"
          ? "\n"
          : "";
    const clean = raw
      .replace(/\r\n|\r|\n/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    if (clean.length === 0) return { kind: "ignore" };
    return {
      kind: "transition",
      state: { ...state, steeringInput: state.steeringInput + clean },
    };
  }
  const step = reduceApprovalStageKey(state, str, key);
  if (step.done) {
    return { kind: "resolved", state: step.state, resolution: step.resolution };
  }
  if (step.state === state) {
    return { kind: "ignore" };
  }
  return { kind: "transition", state: step.state };
}

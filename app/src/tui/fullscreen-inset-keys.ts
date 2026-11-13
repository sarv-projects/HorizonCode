/**
 * fullscreen-inset-keys.ts — keyboard scroll for the inset scrollback pane (ruling **306**).
 */

import type * as readline from "node:readline";

export interface FullscreenInsetKeyState {
  insetOpen: boolean;
  insetScrollUp: number;
  maxInsetScroll: number;
  /** Row count of the inset pane (page scroll step for PgUp/PgDn). */
  insetPaneRows: number;
}

export type FullscreenInsetKeyEffect =
  | { kind: "noop" }
  | { kind: "scroll_inset"; insetScrollUp: number };

function clampInsetScroll(state: FullscreenInsetKeyState, next: number): FullscreenInsetKeyEffect {
  const bounded = Math.max(0, Math.min(state.maxInsetScroll, next));
  if (bounded === state.insetScrollUp) return { kind: "noop" };
  return { kind: "scroll_inset", insetScrollUp: bounded };
}

/** Alt+↑/↓ or PgUp/PgDn when the inset pane is open. */
export function applyFullscreenInsetKey(
  key: readline.Key,
  state: FullscreenInsetKeyState,
): FullscreenInsetKeyEffect {
  if (!state.insetOpen || state.maxInsetScroll <= 0) return { kind: "noop" };

  const pageStep = Math.max(1, state.insetPaneRows);
  const altUp = key.meta === true && key.name === "up";
  const altDown = key.meta === true && key.name === "down";
  if (altUp) return clampInsetScroll(state, state.insetScrollUp + 1);
  if (altDown) return clampInsetScroll(state, state.insetScrollUp - 1);

  if (key.name === "pageup") return clampInsetScroll(state, state.insetScrollUp + pageStep);
  if (key.name === "pagedown") return clampInsetScroll(state, state.insetScrollUp - pageStep);

  return { kind: "noop" };
}

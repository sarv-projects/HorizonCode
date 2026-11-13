/**
 * fullscreen-experimental.ts — alt-screen probe helper (docs/33 §5.17 ruling 186).
 *
 * Alt-screen probe helper (tests / doctor). Production uses `fullscreen-chat.ts` for the
 * reduced interactive loop when `HZ_TUI_MODE=fullscreen-experimental`.
 */

import { bufferFromLines, diffBuffers, encodeDiffRuns, type CellBuffer } from "./cellbuffer";
import { EscapeWriter } from "./escape-writer";

export const FULLSCREEN_EXPERIMENTAL_STATUS =
  "hzcode: fullscreen-experimental (alt-screen probe; docs/33 §5.17)";

export interface FullscreenExperimentalHooks {
  write: (data: string) => void;
  enterRawMode?: () => void;
  leaveRawMode?: () => void;
  columns?: number;
}

/** Paint a one-line status buffer inside an already-entered alt screen. */
export function experimentalStatusBuffer(columns: number): CellBuffer {
  const w = Math.max(40, Math.min(columns, 120));
  return bufferFromLines([FULLSCREEN_EXPERIMENTAL_STATUS.slice(0, w - 1)], w, 1);
}

/**
 * Enter alt-screen, draw one status line, restore. Safe when stdout is not a TTY (no-op).
 */
export function runFullscreenExperimentalProbe(hooks: FullscreenExperimentalHooks = defaultHooks()): void {
  if (!process.stdout.isTTY) return;
  const writer = new EscapeWriter({ hooks });
  writer.installLifecycleHandlers();
  try {
    writer.enterFullscreen();
    writer.markCursorHidden();
    const cols = hooks.columns ?? process.stdout.columns ?? 80;
    const frame = experimentalStatusBuffer(cols);
    hooks.write(encodeDiffRuns(diffBuffers(null, frame)));
  } finally {
    writer.restore();
  }
}

function defaultHooks(): FullscreenExperimentalHooks {
  return {
    write: (data) => process.stdout.write(data),
    enterRawMode: () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
    },
    leaveRawMode: () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    },
    columns: process.stdout.columns,
  };
}

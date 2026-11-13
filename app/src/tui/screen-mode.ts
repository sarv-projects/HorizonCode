/**
 * TUI screen mode resolution (docs/33 §5.17).
 *
 * `fullscreen` and `fullscreen-experimental` both select the reduced alt-screen
 * chat (`fullscreen-chat.ts`). Residuals: mouse hit-test, in-app scrollback pane,
 * diff gutters/cards, rich approval card (docs/13 D*).
 */

import { tuiFullscreenBlocksLabel } from "./escape-writer";

export { tuiFullscreenBlocksLabel };

export type TuiScreenMode = "scrollback" | "fullscreen" | "fullscreen-experimental";

const SCROLLBACK_ALIASES = new Set(["scrollback", "default", "minimal", ""]);
const FULLSCREEN_ALIASES = new Set(["fullscreen", "full", "alt", "alternate"]);
const FULLSCREEN_EXPERIMENTAL_ALIASES = new Set([
  "fullscreen-experimental",
  "fullscreen_experimental",
  "alt-experimental",
  "alt-experimental-probe",
]);

function normalizeMode(raw: string | undefined): TuiScreenMode | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase();
  if (SCROLLBACK_ALIASES.has(key)) return "scrollback";
  if (FULLSCREEN_EXPERIMENTAL_ALIASES.has(key)) return "fullscreen-experimental";
  if (FULLSCREEN_ALIASES.has(key)) return "fullscreen";
  return undefined;
}

/** CLI flag wins, then `HZ_TUI_MODE`, then scrollback. */
export function resolveTuiScreenMode(
  env: Record<string, string | undefined>,
  cli?: TuiScreenMode,
): TuiScreenMode {
  if (cli !== undefined) return cli;
  const fromEnv = normalizeMode(env.HZ_TUI_MODE);
  return fromEnv ?? "scrollback";
}

/** True when the interactive path should run the reduced alt-screen chat. */
export function isFullscreenChatMode(mode: TuiScreenMode): boolean {
  return mode === "fullscreen" || mode === "fullscreen-experimental";
}

/** Opt-in mouse reporting for fullscreen chat (`HZ_TUI_MOUSE=1`). */
export function isTuiMouseEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_TUI_MOUSE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** @deprecated Kept for tests that still assert the old fail-closed copy. */
export function fullscreenNotImplementedMessage(): string {
  return (
    "hzcode: fullscreen TUI uses the reduced alt-screen chat (docs/33 §5.17); " +
    "residuals: mouse, gutters, rich approval — use scrollback for the default chat bar\n"
  );
}

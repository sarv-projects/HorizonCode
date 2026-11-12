/**
 * TUI screen mode resolution (docs/33 §5.17). Only scrollback is implemented today;
 * fullscreen is recognised so callers can fail closed with an honest message.
 */

export type TuiScreenMode = "scrollback" | "fullscreen";

const SCROLLBACK_ALIASES = new Set(["scrollback", "default", "minimal", ""]);
const FULLSCREEN_ALIASES = new Set(["fullscreen", "full", "alt", "alternate"]);

function normalizeMode(raw: string | undefined): TuiScreenMode | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase();
  if (SCROLLBACK_ALIASES.has(key)) return "scrollback";
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

export function fullscreenNotImplementedMessage(): string {
  return (
    "hzcode: fullscreen TUI is not implemented yet (docs/33 §5.17); " +
    "unset HZ_TUI_MODE or --fullscreen and use the default scrollback chat bar\n"
  );
}

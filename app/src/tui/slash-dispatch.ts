/**
 * slash-dispatch.ts — parse slash input + fullscreen local-run dispatch table (docs/28 ruling 240).
 *
 * Pure helpers shared by scrollback `interactive.ts` and alt-screen `fullscreen-chat.ts`.
 */

/** Builtin verbs fullscreen may execute in-loop (never `runtime.send`). */
export const FULLSCREEN_LOCAL_SLASH_NAMES = [
  "help",
  "?",
  "theme",
  "copy",
  "autonomy",
  "mode",
  "notify",
  "trust",
  "settings",
  "stats",
  "tokens",
  "learn",
  "graph",
  "files",
  "context",
  "status",
  "unknown",
  "models",
  "think",
  "plan",
  "changes",
  "apply",
  "discard",
  "rename",
  "export",
  "memory",
  "instructions",
  "worktree",
  "snapshot",
] as const;

export type FullscreenLocalSlashName = (typeof FULLSCREEN_LOCAL_SLASH_NAMES)[number];

const LOCAL_SET = new Set<string>(FULLSCREEN_LOCAL_SLASH_NAMES);

/** Verbs that open an overlay or need the scrollback loop (not inline fullscreen). */
export const FULLSCREEN_DEFERRED_SLASH_NAMES = [
  "exit",
  "quit",
  "new",
  "fork",
  "sessions",
  "palette",
  "commands",
  "transcript",
  "retry",
  "init",
  "rewind",
  "model",
] as const;

const DEFERRED_SET = new Set<string>(FULLSCREEN_DEFERRED_SLASH_NAMES);

/**
 * Split a composer line into slash name + argument. Returns null when the line
 * is not a slash message.
 */
export function parseSlashInput(text: string): { name: string; arg: string; raw: string } | null {
  const raw = text.trim();
  if (raw === "" || !raw.startsWith("/")) return null;
  const body = raw.slice(1).trim();
  if (body === "") return { name: "", arg: "", raw };
  const spaceAt = body.search(/\s/);
  const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const arg = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();
  return { name, arg, raw };
}

export function isFullscreenLocalSlash(name: string): boolean {
  return LOCAL_SET.has(name.toLowerCase());
}

export function isFullscreenDeferredSlash(name: string): boolean {
  return DEFERRED_SET.has(name.toLowerCase());
}

/** Palette Enter runs the handler immediately for these builtins (bare, no args). */
export function fullscreenPaletteRunsImmediately(commandName: string): boolean {
  const name = commandName.toLowerCase();
  if (!isFullscreenLocalSlash(name)) return false;
  if (name === "rename" || name === "apply" || name === "export") return false;
  return true;
}

export function slashComposerSeed(commandName: string): string {
  return `/${commandName} `;
}

/**
 * slash-registry.ts — built-in slash command metadata (docs/33 §5.19 partial).
 *
 * Single source for `/help`, Tab completion (`BUILTIN_COMMANDS`), and custom-command shadowing.
 */

/** One built-in slash command row for help and (later) palette/completion. */
export interface SlashCommandRow {
  /** What the user types, including `/`. */
  usage: string;
  /** Short human description. */
  description: string;
  /** Primary name without `/` (for matching). */
  name: string;
  aliases?: readonly string[];
}

export const BUILTIN_SLASH_REGISTRY: readonly SlashCommandRow[] = [
  { name: "help", usage: "/help", description: "this list", aliases: ["?"] },
  { name: "palette", usage: "/palette [query]", description: "ranked slash commands (scrollback print; fullscreen overlay + Ctrl+P)", aliases: ["commands"] },
  { name: "transcript", usage: "/transcript", description: "open this chat in $PAGER (plain text)" },
  { name: "new", usage: "/new", description: "start a fresh session" },
  { name: "model", usage: "/model [name]", description: "show or switch the model" },
  { name: "models", usage: "/models", description: "list models for the current provider (registry + catalog)" },
  { name: "files", usage: "/files", description: "tools the assistant can use" },
  { name: "context", usage: "/context", description: "what the next request will carry" },
  {
    name: "unknown",
    usage: "/unknown [inspect <id>|reconcile [--probe]|export]",
    description: "UNKNOWN effects: list, inspect receipt, observe-only reconcile, read-only probe, export evidence JSON",
  },
  { name: "plan", usage: "/plan [on|off]", description: "toggle plan mode (writes are staged)" },
  {
    name: "mode",
    usage: "/mode [name]",
    description: "show or set the permission mode: default, plan, accept-edits, read-only",
  },
  {
    name: "autonomy",
    usage: "/autonomy [preset]",
    description: "scrollback autonomy ladder (presets + modes); set by preset id or permission mode name",
  },
  { name: "changes", usage: "/changes", description: "review staged changes and diffs" },
  { name: "apply", usage: "/apply", description: "write the staged changes" },
  { name: "discard", usage: "/discard", description: "drop the staged changes" },
  {
    name: "fork",
    usage: "/fork [n]",
    description: "branch this chat into a new session (n = checkpoint number, else everything so far)",
  },
  {
    name: "sessions",
    usage: "/sessions [query]",
    description: "recent sessions, or FTS search over titles and user prompts (resume with hzcode --resume <id>)",
  },
  { name: "rename", usage: "/rename <title>", description: "retitle this session" },
  { name: "retry", usage: "/retry", description: "drop the last reply and ask the same question again" },
  { name: "theme", usage: "/theme [name]", description: "dark, light, auto or mono (NO_COLOR is always respected)" },
  { name: "think", usage: "/think", description: "show the last reasoning block (rich mode)" },
  { name: "stats", usage: "/stats", description: "message, tool call and token counts for this chat" },
  { name: "tokens", usage: "/tokens", description: "per-chunk context cost table with $ estimates and hints" },
  { name: "learn", usage: "/learn [chapter]", description: "list or read one knowledge-base chapter (under .hz/state/learn)" },
  { name: "trust", usage: "/trust", description: "folder-trust status and digests for this workspace" },
  { name: "settings", usage: "/settings", description: "effective config and sources (secrets masked)" },
  { name: "graph", usage: "/graph", description: "ASCII curator proposal graph (growth store)" },
  {
    name: "export",
    usage: "/export [json|html|hzs]",
    description: "write the chat to .hz/exports (html: receipt chain; hzs: portable archive v1, export only)",
  },
  { name: "copy", usage: "/copy", description: "copy the last answer to the clipboard (terminal OSC 52)" },
  { name: "rewind", usage: "/rewind [n]", description: "list checkpoints; n restores the files changed since one" },
  {
    name: "worktree",
    usage: "/worktree",
    description: "hz sibling worktree pool status (reuse with hzcode --worktree <name>; not kernel leases)",
  },
  {
    name: "snapshot",
    usage: "/snapshot",
    description: "workspace capture honesty (S-50 disabled; SNAPSHOT_CAPTURE_UNAVAILABLE; /rewind for message scope)",
  },
  {
    name: "memory",
    usage: "/memory",
    description: "which instruction files (AGENTS.md, CLAUDE.md, ...) are loaded (alias /instructions)",
    aliases: ["instructions"],
  },
  { name: "init", usage: "/init", description: "draft an AGENTS.md for this repo (staged; you review it, then /apply)" },
  { name: "exit", usage: "/exit", description: "leave (Ctrl+D also works)", aliases: ["quit"] },
];

/** Built-in slash names (primary + aliases) for completion and command-file shadowing. */
export function builtinSlashCommandNames(): readonly string[] {
  const names = new Set<string>();
  for (const row of BUILTIN_SLASH_REGISTRY) {
    names.add(row.name);
    for (const alias of row.aliases ?? []) names.add(alias);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Rows for `printHelp`: `[usage, description]`. */
export function builtinSlashHelpRows(): Array<[string, string]> {
  return BUILTIN_SLASH_REGISTRY.map((r) => [r.usage, r.description]);
}

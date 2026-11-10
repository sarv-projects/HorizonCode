/**
 * commands.ts - custom slash commands as files (T-13).
 *
 * A command is a markdown prompt template under `<workspace config>/commands/*.md`
 * (`<workspace>/.hz/commands/`, or `.hzcode/commands/` in a legacy workspace)
 * or `<user config>/commands/*.md` (`~/.config/horizon/commands/`):
 *
 *   ---
 *   description: Review the staged diff
 *   ---
 *   Review this change and list risks. Focus: {{args}}
 *
 * `/name some text` expands the body, replacing `{{args}}` (or `$ARGUMENTS`,
 * Claude Code style) with the text after the name; a body with no placeholder
 * gets the args appended. The expansion is sent as the user message.
 *
 * A command is prompt text and nothing else: it carries no authority. Whatever
 * the model then does still goes through the kernel guard and gets a receipt.
 * Builtin slash commands always win by name, a workspace command shadows a user
 * command, and a command shadows a skill of the same name. Malformed files are
 * skipped silently, like skills.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stateRoot, userConfigDir } from "./paths";

export interface CustomCommand {
  name: string;
  description: string;
  /** The template body (frontmatter removed, capped). */
  body: string;
  /** The file the command was read from. */
  source: string;
}

/** Slash commands the TUI handles itself; a file can never take one of these names. */
export const BUILTIN_COMMANDS: readonly string[] = [
  "help",
  "?",
  "exit",
  "quit",
  "new",
  "model",
  "files",
  "context",
  "mode",
  "plan",
  "changes",
  "apply",
  "discard",
  "fork",
  "sessions",
  "rewind",
  "memory",
  "instructions",
  "init",
  "rename",
  "retry",
  "stats",
  "export",
  "copy",
];

/** Largest template body kept; the rest is dropped. */
export const COMMAND_BODY_CAP = 8000;
/** Largest file read at all; bigger files are skipped as malformed. */
const COMMAND_FILE_CAP = 64 * 1024;
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start >= lines.length || lines[start].trim() !== "---") return { meta: {}, body: raw };
  let end = -1;
  for (let i = start + 1; i < Math.min(lines.length, start + 60); i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(start + 1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value !== "") meta[match[1].toLowerCase()] = value;
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

function readCommandFile(file: string): CustomCommand | undefined {
  try {
    const stat = lstatSync(file); // lstat: a symlink must not smuggle a file past the read guard
    if (!stat.isFile() || stat.size > COMMAND_FILE_CAP) return undefined;
    const { meta, body } = frontmatter(readFileSync(file, "utf8"));
    const name = (meta.name ?? path.basename(file, path.extname(file))).trim();
    if (!COMMAND_NAME.test(name)) return undefined;
    const trimmed = body.trim();
    if (trimmed === "") return undefined;
    return {
      name,
      description: (meta.description ?? "").trim(),
      body: trimmed.length > COMMAND_BODY_CAP ? trimmed.slice(0, COMMAND_BODY_CAP) : trimmed,
      source: file,
    };
  } catch {
    return undefined;
  }
}

/** User first, then the workspace, so a workspace command shadows a user one. */
function commandDirs(workspace: string): string[] {
  const dirs: string[] = [];
  try {
    const home = os.homedir();
    if (home !== "") dirs.push(path.join(userConfigDir(home), "commands"));
  } catch {
    /* no home directory: workspace commands only */
  }
  dirs.push(path.join(stateRoot(workspace), "commands"));
  return dirs;
}

export interface CommandListing {
  commands: CustomCommand[];
  /** Names found in files but ignored because a builtin owns them. */
  shadowed: string[];
}

/** Every custom command visible from a workspace, plus builtin-name collisions. */
export function loadCommands(workspace: string): CommandListing {
  const byName = new Map<string, CustomCommand>();
  const shadowed = new Set<string>();
  for (const dir of commandDirs(workspace)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
      const command = readCommandFile(path.join(dir, entry));
      if (!command) continue;
      if (BUILTIN_COMMANDS.includes(command.name)) {
        shadowed.add(command.name);
        continue;
      }
      byName.set(command.name, command);
    }
  }
  return {
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    shadowed: [...shadowed].sort(),
  };
}

export function listCommands(workspace: string): CustomCommand[] {
  return loadCommands(workspace).commands;
}

/** Fill the template: `{{args}}` / `$ARGUMENTS`, else append the args. */
export function expandCommand(command: CustomCommand, args: string): string {
  const text = args.trim();
  const placeholder = /\{\{\s*args\s*\}\}|\$ARGUMENTS/g;
  if (placeholder.test(command.body)) {
    // A function replacer keeps `$&` and friends in the args literal.
    return command.body.replace(placeholder, () => text).trim();
  }
  return text === "" ? command.body : `${command.body}\n\n${text}`;
}

/** `/name args` -> the expanded prompt, or undefined when no custom command matches. */
export function resolveCommandForMessage(
  workspace: string,
  text: string,
): { command: CustomCommand; prompt: string } | undefined {
  const value = typeof text === "string" ? text.trim() : "";
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(value);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  if (BUILTIN_COMMANDS.includes(name)) return undefined;
  const command = listCommands(workspace).find((c) => c.name === name);
  if (!command) return undefined;
  return { command, prompt: expandCommand(command, match[2] ?? "") };
}

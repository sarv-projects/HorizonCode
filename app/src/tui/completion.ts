/**
 * completion.ts : Tab completion and ghost text for the chat bar.
 *
 * Two completion contexts, both pure functions over the current line:
 *   - `/name`  a slash command (built-ins plus the custom files in .hz/commands)
 *   - `@path`  a workspace-relative file or directory (the last word of the line)
 *
 * `complete` has the shape of a readline completer (`[hits, token]`), so Tab
 * works natively: one hit completes, several complete the common prefix and list
 * the rest. `ghostFor` is the dim inline suggestion drawn after the cursor.
 */

import { readdirSync } from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "./style";

/** Directories never offered for `@` completion. */
const SKIP_DIRS = new Set([".git", "node_modules", ".hz", ".hzcode"]);
/** C0, DEL, C1, and invisible/bidi format characters. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/;
/** Most entries listed from one directory. */
const LIST_CAP = 200;

export interface CompletionContext {
  workspace: string;
  /** Slash command names without the slash (built-ins and custom). */
  commands: readonly string[];
}

/** The `@` token at the end of the line, or undefined. */
function atToken(line: string): string | undefined {
  const m = /(?:^|\s)(@[^\s]*)$/.exec(line);
  return m ? m[1] : undefined;
}

function listDir(workspace: string, rel: string): string[] {
  const root = path.resolve(workspace);
  const dir = path.resolve(root, rel === "" ? "." : rel);
  // Stay inside the workspace: no `..` climbing, no absolute paths.
  if (dir !== root && !dir.startsWith(root + path.sep)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).slice(0, LIST_CAP * 4);
    const names = entries
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      // A name with control, C1 or bidi/invisible characters is never offered: it
      // would be written raw to the terminal (ESC sequences) or spoof the path.
      .filter((e) => !UNSAFE_NAME.test(e.name))
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    // Directories first, then files, each alphabetical; dotfiles only when asked for.
    return names.sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)).slice(0, LIST_CAP);
  } catch {
    return [];
  }
}

/** Full-token candidates for the line (each starts with the typed token). */
export function candidates(line: string, ctx: CompletionContext): { hits: string[]; token: string } {
  const at = atToken(line);
  if (at !== undefined) {
    const typed = at.slice(1);
    const cut = typed.lastIndexOf("/");
    const dirPart = cut >= 0 ? typed.slice(0, cut + 1) : "";
    const base = typed.slice(cut + 1);
    const hits = listDir(ctx.workspace, dirPart)
      .filter((n) => n.startsWith(base) && (base.startsWith(".") || !n.startsWith(".")))
      .map((n) => "@" + dirPart + n);
    return { hits, token: at };
  }
  if (line.startsWith("/") && !/\s/.test(line)) {
    const typed = line.slice(1).toLowerCase();
    const seen = new Set<string>();
    const hits: string[] = [];
    for (const name of ctx.commands) {
      if (name === "?" || !name.toLowerCase().startsWith(typed) || seen.has(name)) continue;
      seen.add(name);
      hits.push("/" + name);
    }
    return { hits: hits.sort(), token: line };
  }
  return { hits: [], token: line };
}

/** readline completer: `[completions, substringBeingCompleted]`. */
export function complete(line: string, ctx: CompletionContext): [string[], string] {
  const { hits, token } = candidates(line, ctx);
  return [hits, token];
}

/** Max rows shown in the scrollback completion popup (docs/33 §5.18). */
export const DROPDOWN_MAX_ROWS = 8;

/**
 * Format a completion popup for scrollback mode (print-once above the prompt).
 * Pure: no terminal I/O. Selected row is marked with `>`; others with a space.
 * When there are more hits than `maxRows`, a footer names the remainder.
 */
export function formatCompletionDropdown(
  hits: readonly string[],
  selectedIndex = 0,
  maxRows = DROPDOWN_MAX_ROWS,
): string {
  if (hits.length === 0) return "";
  const cap = Math.max(1, maxRows);
  const selected = Math.min(Math.max(0, selectedIndex), hits.length - 1);
  // Keep the selected row in the visible window.
  let start = 0;
  if (selected >= cap) start = selected - cap + 1;
  const slice = hits.slice(start, start + cap);
  const width = Math.min(
    40,
    Math.max(12, ...slice.map((h) => visibleWidth(h)), visibleWidth("… +N more")),
  );
  const lines: string[] = [];
  lines.push("┌" + "─".repeat(width + 2) + "┐");
  for (let i = 0; i < slice.length; i += 1) {
    const hit = slice[i]!;
    const abs = start + i;
    const mark = abs === selected ? ">" : " ";
    const label = visibleWidth(hit) > width ? hit.slice(0, Math.max(1, width - 1)) + "…" : hit;
    const pad = " ".repeat(Math.max(0, width - visibleWidth(label)));
    lines.push(`│${mark}${label}${pad}│`);
  }
  const remaining = hits.length - slice.length;
  if (remaining > 0) {
    const footer = `… +${remaining} more`;
    const pad = " ".repeat(Math.max(0, width - visibleWidth(footer)));
    lines.push(`│ ${footer}${pad}│`);
  }
  lines.push("└" + "─".repeat(width + 2) + "┘");
  return lines.join("\n");
}

/**
 * The dim suffix shown after the cursor: the rest of the first candidate when
 * something was typed. "" when nothing sensible can be suggested.
 */
export function ghostFor(line: string, ctx: CompletionContext): string {
  if (line === "" || line === "/" || line === "@") return "";
  const { hits, token } = candidates(line, ctx);
  const first = hits[0];
  if (first === undefined || first === token || !first.startsWith(token)) return "";
  const suffix = first.slice(token.length);
  if (visibleWidth(suffix) === 0) return "";
  return suffix;
}

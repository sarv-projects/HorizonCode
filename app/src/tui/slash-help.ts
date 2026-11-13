/**
 * slash-help.ts — /help output shared by scrollback and fullscreen (ruling 240).
 */

import { loadCommands } from "../core/commands";
import { builtinSlashHelpRows } from "../core/slash-registry";
import type { Renderer } from "./render";
import { bold, dim, strip, terminalWidth, visibleWidth, wrapText } from "./style";

function printWrapped(r: Renderer, text: string, style: (s: string) => string = (s) => s): void {
  const plain = strip(text);
  if (visibleWidth(plain) <= terminalWidth()) {
    r.line(text);
    return;
  }
  for (const part of wrapText(plain, terminalWidth())) r.line(style(part));
}

export function printSlashHelp(r: Renderer, workspace?: string): void {
  const rows = builtinSlashHelpRows();
  const width = rows.reduce((max, [cmd]) => Math.max(max, cmd.length), 0) + 2;
  r.line(dim("Just type what you want in plain language — no flags needed."));
  r.line("");
  for (const [cmd, desc] of rows) r.line("  " + bold(cmd.padEnd(width)) + dim(desc));
  r.line("");
  if (workspace !== undefined) {
    let listing: ReturnType<typeof loadCommands> = { commands: [], shadowed: [] };
    try {
      listing = loadCommands(workspace);
    } catch {
      /* a bad commands dir never breaks /help */
    }
    if (listing.commands.length > 0) {
      r.line("");
      r.line(dim("Custom commands (prompt templates from .hz/commands):"));
      const cw = listing.commands.reduce((max, c) => Math.max(max, c.name.length + 1), 0) + 2;
      for (const c of listing.commands) r.line("  " + bold(("/" + c.name).padEnd(cw)) + dim(c.description));
    }
    if (listing.shadowed.length > 0) {
      r.line(dim(`  ignored (a builtin owns the name): ${listing.shadowed.map((n) => "/" + n).join(", ")}`));
    }
  }
  printWrapped(
    r,
    "  Ctrl+C  stop the current answer (again to leave)   Ctrl+D  leave   ↑/↓  earlier messages",
    dim,
  );
}

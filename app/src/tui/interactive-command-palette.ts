/**
 * interactive-command-palette.ts — Interactive Command Palette Modal
 *
 * Stolen & adapted from:
 *   - repo_take/opencode/packages/tui/src/component/command-palette.tsx
 *   - repo_take/claude-code-src/claude-code-source-code/src/components/PromptInput/PromptInputHelpMenu.tsx
 *
 * Displays an interactive menu of slash commands, allows searching/filtering,
 * and executes the chosen command directly.
 */

import * as readline from "node:readline";
import { BUILTIN_SLASH_REGISTRY, type SlashCommandRow } from "../core/slash-registry";
import { bold, cyan, dim, green } from "./style";

export async function runInteractiveCommandPalette(
  customNames: readonly string[] = [],
  opts: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
  } = {}
): Promise<string | null> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const write = (s: string) => stdout.write(s);

  const rows: SlashCommandRow[] = [...BUILTIN_SLASH_REGISTRY];
  for (const name of customNames) {
    if (!rows.some((r) => r.name === name)) {
      rows.push({ name, usage: `/${name}`, description: "Custom command" });
    }
  }

  write("\n" + bold(cyan("◆ HorizonCode Command Palette")) + " · Select or search a command\n\n");

  const displayLimit = Math.min(15, rows.length);
  for (let i = 0; i < displayLimit; i += 1) {
    const r = rows[i]!;
    const num = bold(`[${i + 1}]`.padEnd(5));
    const usage = cyan(r.usage.padEnd(24));
    const desc = dim(r.description);
    write(`  ${num} ${usage} ${desc}\n`);
  }
  if (rows.length > displayLimit) {
    write(dim(`  ... and ${rows.length - displayLimit} more commands (type /<name> to run)\n`));
  }
  write(`  ${bold("[0]".padEnd(5))} ${dim("Cancel")}\n\n`);

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean((stdout as any).isTTY),
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans.trim())));

  try {
    const input = await question(bold("❯ Select command [1-15, or type command name, 0 to cancel]: "));
    if (input === "" || input === "0") return null;

    const idx = parseInt(input, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= rows.length) {
      return `/${rows[idx - 1]!.name}`;
    }

    // Direct name match or prefix match
    const clean = input.startsWith("/") ? input.slice(1).toLowerCase() : input.toLowerCase();
    const match = rows.find((r) => r.name.toLowerCase() === clean || (r.aliases ?? []).some((a) => a.toLowerCase() === clean));
    if (match) {
      return `/${match.name}`;
    }

    const prefix = rows.find((r) => r.name.toLowerCase().startsWith(clean));
    if (prefix) {
      return `/${prefix.name}`;
    }

    return null;
  } finally {
    rl.close();
  }
}

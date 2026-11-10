/**
 * banner.ts — the 4-line startup banner plus the opening hint.
 *
 * Compact on purpose: `hzcode` should feel like opening a chat window, not
 * booting a machine. Printed once, above the chat bar.
 */

import { bold, cyan, dim, green, strip, terminalWidth, visibleWidth, wrapText, yellow } from "./style";

export interface BannerInfo {
  /** full version, e.g. "0.1.0" */
  version: string;
  model: string;
  provider: string;
  workspace: string;
  kernel: string;
}

/** One-line hint shown under the banner while the chat bar is empty. */
export const GREETING = "Type a message to start \u2014 /help for commands.";

function shortVersion(version: string): string {
  const parts = String(version ?? "").split(".").filter(Boolean);
  return parts.slice(0, 2).join(".") || String(version ?? "");
}

/** `~` for the home directory: keeps the workspace line short and readable. */
export function shortenPath(p: string): string {
  const value = String(p ?? "");
  const home = process.env.HOME;
  if (home && value === home) return "~";
  if (home && value.startsWith(home + "/")) return "~" + value.slice(home.length);
  return value;
}

export interface PrintOptions {
  out?: (chunk: string) => void;
  /** width to fit into; defaults to the terminal width */
  width?: number;
}

/**
 * Print the banner. `out` defaults to stdout; the interactive loop passes its
 * renderer so the line state stays consistent.
 */
export function printBanner(info: BannerInfo, opts: PrintOptions = {}): void {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const width = Math.max(20, opts.width ?? terminalWidth());

  const kernel = String(info.kernel ?? "unknown");
  const lines: string[] = [
    bold(cyan("HzCode")) + dim(" v" + shortVersion(info.version)),
    dim("model ") + String(info.model ?? "unknown") + dim(" \u00b7 provider ") + String(info.provider ?? "unknown"),
    dim("workspace ") + shortenPath(info.workspace),
    dim("kernel ") + (kernel === "trusted" ? green(kernel) : yellow(kernel)),
  ];

  for (const line of lines) {
    if (visibleWidth(line) <= width) {
      out(line + "\n");
      continue;
    }
    // Wider than the terminal (e.g. a very deep workspace path): wrap it rather
    // than letting the terminal reflow in the middle of an escape sequence.
    for (const part of wrapText(strip(line), width)) out(dim(part) + "\n");
  }
}

/**
 * The TTY banner: a styled wordmark, the same facts, and one tip. Only used
 * when colour and animation are on; piped/plain sessions keep printBanner.
 */
export function printRichBanner(info: BannerInfo, opts: PrintOptions & { tip?: string } = {}): void {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const width = Math.max(20, opts.width ?? terminalWidth());
  const kernel = String(info.kernel ?? "unknown");
  const lines: string[] = [
    cyan("\u25c6") + " " + bold("Horizon") + bold(cyan("Code")) + dim(" v" + shortVersion(info.version) + " \u00b7 terminal coding agent"),
    "  " + dim("model ") + String(info.model ?? "unknown") + dim(" \u00b7 provider ") + String(info.provider ?? "unknown"),
    "  " + dim("workspace ") + shortenPath(info.workspace),
    "  " + dim("kernel ") + (kernel === "trusted" ? green(kernel) : yellow(kernel)),
  ];
  if (opts.tip) lines.push("  " + yellow("tip") + dim(" " + opts.tip));
  for (const line of lines) {
    if (visibleWidth(line) <= width) {
      out(line + "\n");
      continue;
    }
    for (const part of wrapText(strip(line), width)) out(dim(part) + "\n");
  }
}

/** The hint line under the banner. */
export function printGreeting(opts: PrintOptions = {}): void {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  out(dim(GREETING) + "\n");
}

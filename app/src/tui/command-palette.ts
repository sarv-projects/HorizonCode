/**
 * command-palette.ts — scrollback-safe slash palette (docs/13 D5 reduced).
 *
 * Full overlay needs 5.17; this prints a one-shot ranked list like Tab completion.
 */

import { BUILTIN_SLASH_REGISTRY, type SlashCommandRow } from "../core/slash-registry";
import { fuzzyScore } from "./fuzzy";
import { formatHzReceiptUri, parseHzReceiptUri } from "./receipt-uri";
import { dim } from "./style";

export interface PaletteOptions {
  customNames?: readonly string[];
  width?: number;
  maxRows?: number;
}

function paletteRows(custom: readonly string[]): SlashCommandRow[] {
  const builtins = [...BUILTIN_SLASH_REGISTRY];
  const seen = new Set(builtins.map((r) => r.name));
  for (const name of custom) {
    if (seen.has(name)) continue;
    seen.add(name);
    builtins.push({ name, usage: `/${name}`, description: "custom command" });
  }
  return builtins;
}

function paletteHaystack(row: SlashCommandRow): string {
  return `${row.name} ${(row.aliases ?? []).join(" ")} ${row.description}`;
}

/** Built-ins plus custom command rows (one registry for scrollback + fullscreen). */
export function listPaletteCommands(customNames: readonly string[] = []): SlashCommandRow[] {
  return paletteRows(customNames);
}

/** Fuzzy-ranked slash rows without receipt URI injection (base ranker). */
export function rankPaletteCommandsBase(
  query: string,
  customNames: readonly string[] = [],
  maxRows = 12,
): SlashCommandRow[] {
  const rows = paletteRows(customNames);
  return rows
    .map((row) => ({ row, score: fuzzyScore(query, paletteHaystack(row)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, maxRows)
    .map((x) => x.row);
}

/** Fuzzy-ranked slash rows with hz://receipt/<id> injection when the query matches. */
export function rankPaletteCommandsWithReceipt(
  query: string,
  customNames: readonly string[] = [],
  maxRows = 12,
): SlashCommandRow[] {
  const rows = rankPaletteCommandsBase(query, customNames, maxRows);
  const receiptId = parseHzReceiptUri(query);
  if (receiptId === undefined) return rows;
  const uri = formatHzReceiptUri(receiptId);
  const inject: SlashCommandRow = {
    name: uri,
    usage: uri,
    description: "Open receipt inspector (R172 reduced; not verify)",
  };
  const rest = rows.filter((r) => r.name.toLowerCase() !== uri.toLowerCase());
  return [inject, ...rest].slice(0, maxRows);
}

/** Fuzzy-ranked slash rows for a query (scrollback + fullscreen; includes hz://receipt). */
export function rankPaletteCommands(
  query: string,
  customNames: readonly string[] = [],
  maxRows = 12,
): SlashCommandRow[] {
  return rankPaletteCommandsWithReceipt(query, customNames, maxRows);
}

/** Lines to print above the prompt (no arrow-key UI). */
export function formatCommandPalette(query: string, opts: PaletteOptions = {}): string {
  const width = Math.max(40, opts.width ?? 72);
  const maxRows = opts.maxRows ?? 10;
  const scored = rankPaletteCommands(query, opts.customNames ?? [], maxRows);
  if (scored.length === 0) return dim("no matching commands");
  const labelW = Math.min(28, Math.floor(width * 0.4));
  const lines: string[] = [dim(`commands matching ${JSON.stringify(query)}:`)];
  for (let i = 0; i < scored.length; i += 1) {
    const row = scored[i]!;
    const name = `/${row.name}`.padEnd(labelW).slice(0, labelW);
    const desc = row.description.length > width - labelW - 4 ? row.description.slice(0, width - labelW - 7) + "..." : row.description;
    const mark = i === 0 ? ">" : " ";
    lines.push(`${mark} ${name}  ${desc}`);
  }
  return lines.join("\n");
}

/**
 * Inject hz://receipt/<id> into scrollback + fullscreen command palettes (**288**, **290**).
 */

import type { SlashCommandRow } from "../core/slash-registry";
import { rankPaletteCommandsWithReceipt } from "./command-palette";

export function rankFullscreenPaletteCommands(
  query: string,
  customNames: readonly string[],
  limit = 40,
): SlashCommandRow[] {
  return rankPaletteCommandsWithReceipt(query, customNames, limit);
}

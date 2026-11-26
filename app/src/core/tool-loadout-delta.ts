/**
 * tool-loadout-delta.ts — Group B dynamic tool loadout delta announcements
 * (pi agent-loop ADAPT).
 *
 * When a mid-session tool visibility change occurs, emit toolsAdded /
 * toolsRemoved SYSTEM DELTAS rather than mutating the frozen prompt prefix.
 * Pure diff over two name sets; no prompt rewriting, no authority, no network.
 * Prefix is sacred: callers append the rendered delta to the transcript only.
 */

export interface ToolLoadoutDelta {
  toolsAdded: string[];
  toolsRemoved: string[];
}

/** Diff two tool-name sets into additive/removed deltas (sorted, deterministic). */
export function diffToolLoadout(
  before: readonly string[],
  after: readonly string[],
): ToolLoadoutDelta {
  const b = new Set(before);
  const a = new Set(after);
  return {
    toolsAdded: [...a].filter((n) => !b.has(n)).sort(),
    toolsRemoved: [...b].filter((n) => !a.has(n)).sort(),
  };
}

/** Render a model-ready system delta. Empty when nothing changed. */
export function renderToolLoadoutDelta(delta: ToolLoadoutDelta): string | undefined {
  const lines: string[] = [];
  if (delta.toolsAdded.length > 0) lines.push(`toolsAdded: ${delta.toolsAdded.join(", ")}`);
  if (delta.toolsRemoved.length > 0) lines.push(`toolsRemoved: ${delta.toolsRemoved.join(", ")}`);
  if (lines.length === 0) return undefined;
  return `<system-tool-loadout>\n${lines.join("\n")}\n</system-tool-loadout>`;
}

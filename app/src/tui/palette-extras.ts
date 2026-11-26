/**
 * palette-extras.ts -- expanded command palette context (docs/28 §14).
 *
 * Pure helpers for the /palette modal: keyboard shortcuts, recently changed
 * files, active skills and quick mode toggles. No filesystem or process access
 * here, so every input is injectable and tests stay hermetic.
 */

export interface PaletteShortcut {
  key: string;
  label: string;
}

export interface PaletteToggle {
  label: string;
  value: string;
  command: string;
}

export interface PaletteExtras {
  shortcuts?: readonly PaletteShortcut[];
  recentFiles?: readonly string[];
  activeSkills?: readonly string[];
  toggles?: readonly PaletteToggle[];
}

export const DEFAULT_PALETTE_SHORTCUTS: readonly PaletteShortcut[] = [
  { key: "Tab", label: "complete command or path" },
  { key: "Up/Down", label: "message history" },
  { key: "Ctrl+C", label: "cancel turn" },
  { key: "Ctrl+D", label: "exit" },
];

/** Parse `git status --short` into unique file paths, newest first. */
export function parseRecentFilesFromGitStatus(output: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3) continue;
    let target = line.slice(2).trim();
    if (target === "") continue;
    if (target.includes(" -> ")) target = target.split(" -> ").at(-1)?.trim() ?? target;
    if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
    if (seen.has(target)) continue;
    seen.add(target);
    files.push(target);
  }
  return files;
}

/** The three quick toggles named in docs/28 §14, with their current values. */
export function paletteToggles(current: { plan?: string; autonomy?: string; theme?: string } = {}): PaletteToggle[] {
  return [
    { label: "Plan mode", value: current.plan ?? "toggle", command: "/plan" },
    { label: "Autonomy", value: current.autonomy ?? "toggle", command: "/autonomy" },
    { label: "Theme", value: current.theme ?? "toggle", command: "/theme" },
  ];
}

/** Render only the sections that carry data; blank extras render as "". */
export function renderPaletteExtras(extras: PaletteExtras): string {
  const lines: string[] = [];
  if (extras.shortcuts && extras.shortcuts.length > 0) {
    lines.push("Shortcuts:");
    for (const s of extras.shortcuts) lines.push(`  ${s.key.padEnd(12)} ${s.label}`);
  }
  if (extras.recentFiles && extras.recentFiles.length > 0) {
    lines.push("Recent files:");
    for (const f of extras.recentFiles.slice(0, 8)) lines.push(`  ${f}`);
  }
  if (extras.activeSkills && extras.activeSkills.length > 0) {
    lines.push("Active skills:");
    for (const s of extras.activeSkills.slice(0, 8)) lines.push(`  ${s}`);
  }
  if (extras.toggles && extras.toggles.length > 0) {
    lines.push("Quick toggles:");
    for (const t of extras.toggles) lines.push(`  ${t.command.padEnd(12)} ${t.label}: ${t.value}`);
  }
  return lines.join("\n");
}

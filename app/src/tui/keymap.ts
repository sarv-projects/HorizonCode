/**
 * keymap.ts — action registry + chord parsing (docs/33 §5.19 partial).
 *
 * Mode-independent piece: named actions with default chords. User-config
 * `keybindings.json` may rebind known actions (never protected chords onto a
 * different action). Workspace files are not loaded (same rule as statusLine).
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { userConfigDir } from "../core/paths";

export type KeyContext = "idle" | "busy" | "approval" | "any";

export interface ActionDef {
  id: string;
  description: string;
  /** Default chord, e.g. `escape`, `ctrl+c`, `ctrl+shift+p`. */
  defaultChord: string;
  contexts: readonly KeyContext[];
}

export interface ParsedKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Built-in actions (narrow set matching today's scrollback listeners). */
export const DEFAULT_ACTIONS: readonly ActionDef[] = [
  {
    id: "turn.cancel",
    description: "Cancel the running turn (Esc while busy, no approval open)",
    defaultChord: "escape",
    contexts: ["busy"],
  },
  {
    id: "session.interrupt",
    description: "Stop the current answer; twice to leave (readline Ctrl+C)",
    defaultChord: "ctrl+c",
    contexts: ["any"],
  },
  {
    id: "session.eof",
    description: "Leave the session (readline Ctrl+D)",
    defaultChord: "ctrl+d",
    contexts: ["idle", "any"],
  },
  {
    id: "session.picker",
    description: "Open the resume session picker (fullscreen-experimental; scrollback uses /sessions)",
    defaultChord: "ctrl+r",
    contexts: ["idle", "any"],
  },
];

/** Normalize a chord string to `ctrl+meta+shift+name` (sorted modifiers). */
export function normalizeChord(chord: string): string {
  const parts = chord
    .trim()
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return "";
  const name = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const out: string[] = [];
  if (mods.has("ctrl") || mods.has("control")) out.push("ctrl");
  if (mods.has("meta") || mods.has("alt") || mods.has("option")) out.push("meta");
  if (mods.has("shift")) out.push("shift");
  out.push(name === "esc" ? "escape" : name);
  return out.join("+");
}

/** Format a readline-style key event as a normalized chord. */
export function chordFromKey(key: ParsedKey | undefined): string {
  if (!key?.name) return "";
  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.meta) parts.push("meta");
  if (key.shift) parts.push("shift");
  const name = key.name.toLowerCase() === "esc" ? "escape" : key.name.toLowerCase();
  parts.push(name);
  return normalizeChord(parts.join("+"));
}

export interface Keymap {
  /** action id → normalized chord */
  bindings: Map<string, string>;
  actions: readonly ActionDef[];
}

/** Build the default keymap (no user overrides). */
export function defaultKeymap(): Keymap {
  const bindings = new Map<string, string>();
  for (const a of DEFAULT_ACTIONS) bindings.set(a.id, normalizeChord(a.defaultChord));
  return { bindings, actions: DEFAULT_ACTIONS };
}

/** User keybindings path: `<userConfigDir>/keybindings.json`. */
export function userKeybindingsPath(home: string = process.env.HOME ?? process.env.USERPROFILE ?? ""): string {
  return path.join(userConfigDir(home), "keybindings.json");
}

/**
 * Apply checked overrides onto a base keymap. Invalid overrides are rejected
 * by the caller via `checkKeymapOverrides` before calling this.
 */
export function applyKeymapOverrides(base: Keymap, overrides: Record<string, string>): Keymap {
  const bindings = new Map(base.bindings);
  for (const [id, raw] of Object.entries(overrides)) {
    bindings.set(id, normalizeChord(raw));
  }
  return { bindings, actions: base.actions };
}

/**
 * Load user-config keybindings if present. Returns defaults when missing or
 * invalid; invalid files yield `errors` for the caller to notice.
 */
export function loadUserKeymap(
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): { keymap: Keymap; errors: string[]; path: string } {
  const file = userKeybindingsPath(home);
  const base = defaultKeymap();
  if (!existsSync(file)) return { keymap: base, errors: [], path: file };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { keymap: base, errors: [`${file} must be a JSON object of actionId → chord`], path: file };
    }
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { keymap: base, errors: [`${file}: ${k} must be a string chord`], path: file };
      }
      overrides[k] = v;
    }
    const errors = checkKeymapOverrides(overrides, base);
    if (errors.length > 0) return { keymap: base, errors: errors.map((e) => `${file}: ${e}`), path: file };
    return { keymap: applyKeymapOverrides(base, overrides), errors: [], path: file };
  } catch (e) {
    return { keymap: base, errors: [`${file}: ${e instanceof Error ? e.message : String(e)}`], path: file };
  }
}

/**
 * Resolve which action a key event maps to in `context`.
 * Returns undefined when unbound or not available in this context.
 */
export function resolveAction(
  keymap: Keymap,
  key: ParsedKey | undefined,
  context: KeyContext,
): ActionDef | undefined {
  const chord = chordFromKey(key);
  if (chord === "") return undefined;
  for (const action of keymap.actions) {
    const bound = keymap.bindings.get(action.id);
    if (bound !== chord) continue;
    if (action.contexts.includes("any") || action.contexts.includes(context)) return action;
  }
  return undefined;
}

/** Chords that workspace/user files must never shadow (docs/33 §5.19 R47). */
export const PROTECTED_CHORDS: readonly string[] = ["ctrl+c", "ctrl+d", "y", "n", "a"];

/**
 * Validate optional overrides: unknown action ids fail; shadowing a protected
 * chord fails; duplicates (two actions same chord) fail.
 */
export function checkKeymapOverrides(
  overrides: Record<string, string>,
  base: Keymap = defaultKeymap(),
): string[] {
  const errors: string[] = [];
  const known = new Set(base.actions.map((a) => a.id));
  const chordOwners = new Map<string, string>();
  for (const [id, chord] of base.bindings) chordOwners.set(chord, id);

  for (const [id, raw] of Object.entries(overrides)) {
    if (!known.has(id)) {
      errors.push(`unknown action ${JSON.stringify(id)}`);
      continue;
    }
    const chord = normalizeChord(raw);
    if (chord === "") {
      errors.push(`empty chord for ${id}`);
      continue;
    }
    if (PROTECTED_CHORDS.includes(chord) && base.bindings.get(id) !== chord) {
      errors.push(`cannot rebind protected chord ${chord} onto ${id}`);
      continue;
    }
    const owner = chordOwners.get(chord);
    if (owner !== undefined && owner !== id) {
      errors.push(`chord ${chord} already bound to ${owner}`);
      continue;
    }
    chordOwners.set(chord, id);
  }
  return errors;
}

/**
 * Scrollback helpers for `/autonomy` and bare `/mode` (docs/30 §8 #14 reduced).
 *
 * Lists Plandex-style config presets beside permission modes; session-only
 * selection maps to `permissionMode` via the runtime hook (never a bypass).
 */

import type { Runtime } from "../contracts";
import {
  AUTONOMY_PRESETS,
  autonomyPresetError,
  parseAutonomyPreset,
} from "../core/autonomy-presets";
import {
  BYPASS_REFUSAL,
  type PermissionMode,
  PERMISSION_MODES,
  describeMode,
  isBypassName,
  parsePermissionMode,
} from "../core/permission-mode";
import type { Renderer } from "./render";

export type AutonomySelection =
  | { ok: true; mode: PermissionMode; via: "mode" | "preset" }
  | { ok: false; message: string };

/** Lines for scrollback when the user asks for the ladder with no argument. */
export function formatAutonomyLadderLines(current: PermissionMode): string[] {
  const lines: string[] = [
    `autonomy ladder (session-only; current: ${current})`,
    "",
    "permission modes:",
  ];
  for (const mode of PERMISSION_MODES) {
    const marker = mode === current ? " *" : "";
    lines.push(`  ${mode}${marker} — ${describeMode(mode)}`);
  }
  lines.push("", "config presets (autonomy in config.json → starting permission mode):");
  for (const p of AUTONOMY_PRESETS) {
    const marker = p.permissionMode === current ? " *" : "";
    lines.push(`  ${p.id}${marker} → ${p.permissionMode} — ${p.description}`);
  }
  lines.push(
    "",
    "agent profile `never` (grep/glob only, read-only child) is separate — use profile=never on the agent tool",
    `switch: /mode ${PERMISSION_MODES.join("|")} or /autonomy <preset-id>`,
  );
  return lines;
}

/** Map a slash argument to a permission mode (preset id or mode name). */
export function resolveAutonomySelection(arg: string): AutonomySelection {
  const trimmed = arg.trim();
  if (trimmed === "") {
    return { ok: false, message: `usage: /autonomy <preset-id> or /mode ${PERMISSION_MODES.join("|")}` };
  }
  if (isBypassName(trimmed)) {
    return { ok: false, message: BYPASS_REFUSAL };
  }
  const fromMode = parsePermissionMode(trimmed);
  if (fromMode !== undefined) {
    return { ok: true, mode: fromMode, via: "mode" };
  }
  const preset = parseAutonomyPreset(trimmed);
  if (preset !== undefined) {
    return { ok: true, mode: preset.permissionMode, via: "preset" };
  }
  return {
    ok: false,
    message: `${autonomyPresetError(trimmed)}; or a permission mode: ${PERMISSION_MODES.join(", ")}`,
  };
}

type RuntimeWithExtras = Runtime & {
  setPermissionMode?: (mode: PermissionMode) => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `/autonomy [arg]`: scrollback ladder when empty; preset id or mode name when set.
 * Returns the permission mode now in force (for badge refresh).
 */
export function runAutonomyCommand(
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
  readMode: () => PermissionMode,
): PermissionMode {
  const current = readMode();
  if (arg.trim() === "") {
    for (const line of formatAutonomyLadderLines(current)) {
      renderer.line(line);
    }
    return current;
  }
  const sel = resolveAutonomySelection(arg);
  if (sel.ok === false) {
    renderer.notice(sel.message);
    return current;
  }
  const extras = runtime as RuntimeWithExtras;
  if (typeof extras.setPermissionMode !== "function") {
    renderer.notice(
      `not supported by this runtime: setPermissionMode — this core build does not expose the permission-mode hook`,
    );
    return current;
  }
  try {
    extras.setPermissionMode.call(runtime, sel.mode);
  } catch (err) {
    renderer.notice(`could not change permission mode: ${errorMessage(err)}`);
    return readMode();
  }
  const now = readMode();
  const label = sel.via === "preset" ? `autonomy preset → ${now}` : `permission mode now ${describeMode(now)}`;
  renderer.notice(label);
  return now;
}

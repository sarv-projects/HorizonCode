import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applyKeymapOverrides,
  checkKeymapOverrides,
  chordFromKey,
  defaultKeymap,
  loadUserKeymap,
  normalizeChord,
  resolveAction,
  userKeybindingsPath,
} from "../../src/tui/keymap";

let home: string | undefined;
afterEach(() => {
  if (home) {
    rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
});

describe("keymap", () => {
  test("normalizeChord sorts modifiers and aliases esc", () => {
    expect(normalizeChord("Shift+Ctrl+P")).toBe("ctrl+shift+p");
    expect(normalizeChord("esc")).toBe("escape");
    expect(normalizeChord("alt+x")).toBe("meta+x");
  });

  test("chordFromKey matches readline key objects", () => {
    expect(chordFromKey({ name: "escape" })).toBe("escape");
    expect(chordFromKey({ name: "c", ctrl: true })).toBe("ctrl+c");
    expect(chordFromKey({ name: "p", ctrl: true, shift: true })).toBe("ctrl+shift+p");
  });

  test("default Esc resolves to turn.cancel when busy", () => {
    const km = defaultKeymap();
    expect(resolveAction(km, { name: "escape" }, "busy")?.id).toBe("turn.cancel");
    expect(resolveAction(km, { name: "escape" }, "idle")).toBeUndefined();
    expect(resolveAction(km, { name: "escape", ctrl: true }, "busy")).toBeUndefined();
  });

  test("checkKeymapOverrides rejects unknown and protected shadow", () => {
    expect(checkKeymapOverrides({ "no.such": "x" })).toEqual(['unknown action "no.such"']);
    expect(checkKeymapOverrides({ "turn.cancel": "ctrl+c" }).some((e) => e.includes("protected"))).toBe(
      true,
    );
  });

  test("checkKeymapOverrides accepts rebinding Esc to the same action", () => {
    expect(checkKeymapOverrides({ "turn.cancel": "escape" })).toEqual([]);
  });

  test("loadUserKeymap applies valid overrides from user config dir", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-keymap-home-"));
    // Force canonical user dir under this home.
    mkdirSync(path.join(home, ".config", "horizon"), { recursive: true });
    const file = userKeybindingsPath(home);
    writeFileSync(file, JSON.stringify({ "turn.cancel": "f6" }), "utf8");
    const { keymap, errors } = loadUserKeymap(home);
    expect(errors).toEqual([]);
    expect(resolveAction(keymap, { name: "f6" }, "busy")?.id).toBe("turn.cancel");
    expect(resolveAction(keymap, { name: "escape" }, "busy")).toBeUndefined();
  });

  test("applyKeymapOverrides is a pure merge", () => {
    const km = applyKeymapOverrides(defaultKeymap(), { "turn.cancel": "f7" });
    expect(km.bindings.get("turn.cancel")).toBe("f7");
  });
});

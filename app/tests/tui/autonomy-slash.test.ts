import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/contracts";
import {
  formatAutonomyLadderLines,
  resolveAutonomySelection,
  runAutonomyCommand,
} from "../../src/tui/autonomy-slash";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";

function setupRenderer() {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
  return { renderer, text: () => strip(chunks.join("")) };
}

describe("autonomy slash helpers", () => {
  test("ladder lists every permission mode and preset", () => {
    const lines = formatAutonomyLadderLines("default");
    const body = lines.join("\n");
    expect(body).toContain("default *");
    expect(body).toContain("manual");
    expect(body).toContain("auto-edits");
    expect(body).toContain("plan-only");
    expect(body).toContain("profile `never`");
  });

  test("resolve accepts mode names and preset ids", () => {
    expect(resolveAutonomySelection("read-only")).toEqual({ ok: true, mode: "read-only", via: "mode" });
    expect(resolveAutonomySelection("auto_edits")).toEqual({ ok: true, mode: "accept-edits", via: "preset" });
    expect(resolveAutonomySelection("plan-only")).toEqual({ ok: true, mode: "plan", via: "preset" });
  });

  test("resolve refuses bypass names", () => {
    const r = resolveAutonomySelection("yolo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("no bypass");
  });

  test("runAutonomyCommand prints scrollback ladder when empty", () => {
    const h = setupRenderer();
    const mode = runAutonomyCommand("", { sessionId: "s" } as Runtime, h.renderer, () => "default");
    expect(mode).toBe("default");
    expect(h.text()).toContain("autonomy ladder");
  });

  test("runAutonomyCommand applies preset via setPermissionMode", () => {
    const h = setupRenderer();
    let current: "default" | "accept-edits" = "default";
    const rt = {
      sessionId: "s",
      setPermissionMode(m: "default" | "accept-edits") {
        current = m;
      },
    } as unknown as Runtime;
    const next = runAutonomyCommand("auto-edits", rt, h.renderer, () => current);
    expect(next).toBe("accept-edits");
    expect(h.text()).toContain("autonomy preset");
  });
});

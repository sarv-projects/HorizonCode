import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/contracts";
import { tryRunFullscreenLocalSlash } from "../../src/tui/fullscreen-slash";
import type { Renderer } from "../../src/tui/render";
import type { PlanCommandState } from "../../src/tui/interactive";

function mockRenderer(): Renderer & { lines: string[]; notices: string[] } {
  const lines: string[] = [];
  const notices: string[] = [];
  return {
    lines,
    notices,
    line: (t) => lines.push(t),
    notice: (t) => notices.push(t),
    write: () => {},
    handle: () => {},
    ensureLineStart: () => {},
    error: (t) => notices.push(t),
    atLineStart: () => true,
    lastThinking: () => "",
  };
}

const runtime = {
  sessionId: "s1",
  model: "mock",
  send: async () => ({ exit: { terminal: "succeeded" } }),
} as unknown as Runtime;

describe("tryRunFullscreenLocalSlash", () => {
  test("/trust and bare /theme emit notices without send", async () => {
    const renderer = mockRenderer();
    const planState: PlanCommandState = { on: false };
    const ctx = {
      runtime,
      renderer,
      workspace: "/tmp/ws",
      write: () => {},
      planState,
    };
  const trust = await tryRunFullscreenLocalSlash("/trust", ctx);
    expect(trust).toBe(true);
    expect(renderer.notices.some((n) => n.includes("Workspace:"))).toBe(true);

    renderer.notices.length = 0;
    const theme = await tryRunFullscreenLocalSlash("/theme", ctx);
    expect(theme).toBe(true);
    expect(renderer.notices.some((n) => n.includes("theme"))).toBe(true);
  });

  test("/status prints permission mode and model", async () => {
    const renderer = mockRenderer();
    const consumed = await tryRunFullscreenLocalSlash("/status", {
      runtime,
      renderer,
      workspace: "/tmp/ws",
      write: () => {},
      planState: { on: false },
      unknownCount: 1,
      unknownReceiptId: "rcpt-abc",
    });
    expect(consumed).toBe(true);
    expect(renderer.notices.join(" ")).toContain("mock");
    expect(renderer.notices.join(" ")).toContain("UNKNOWN");
  });

  test("plain chat is not consumed", async () => {
    const renderer = mockRenderer();
    const consumed = await tryRunFullscreenLocalSlash("hello", {
      runtime,
      renderer,
      workspace: "/tmp/ws",
      write: () => {},
      planState: { on: false },
    });
    expect(consumed).toBe(false);
  });
});

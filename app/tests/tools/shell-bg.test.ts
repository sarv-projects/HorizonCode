import { afterEach, describe, expect, test } from "bun:test";
import {
  beginBackgroundCapture,
  clearAllAutoBackgrounds,
  completeBackgroundCapture,
} from "../../src/core/shell-auto-background";
import { shellBgTool } from "../../src/tools/shell-bg";
import { mockToolContext } from "./helpers";

afterEach(() => clearAllAutoBackgrounds());

describe("shell_bg tool", () => {
  test("poll reports exited once capture records an exit code", async () => {
    const ctx = mockToolContext({ sessionId: "sess-a" });
    beginBackgroundCapture({
      pid: 9001,
      sessionId: "sess-a",
      command: "sleep 9",
      cwd: ctx.cwd,
      logPath: `${ctx.cwd}/bg.log`,
      initialOutput: "line1\n",
      startedAtMs: Date.now() - 1000,
    });
    completeBackgroundCapture(9001, 0, null);
    const done = await shellBgTool.execute({ op: "poll", pid: 9001 }, ctx);
    expect(done.ok).toBe(true);
    expect(done.output).toContain("exited");
    expect(done.output).toContain("exit_code=0");
    expect(done.output).toContain("sleep 9");
  });

  test("output tails captured lines", async () => {
    const ctx = mockToolContext();
    beginBackgroundCapture({
      pid: 9002,
      sessionId: ctx.sessionId,
      command: "echo hi",
      cwd: ctx.cwd,
      logPath: `${ctx.cwd}/bg2.log`,
      initialOutput: "alpha\nbeta\ngamma\n",
      startedAtMs: Date.now(),
    });
    const r = await shellBgTool.execute({ op: "output", pid: 9002, lines: 2 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("beta");
    expect(r.output).toContain("gamma");
    expect(r.output).not.toContain("alpha");
  });

  test("kill admits shell.exec through the guard", async () => {
    const ctx = mockToolContext({ decision: "ask", approve: false });
    const r = await shellBgTool.execute({ op: "kill", pid: 999_999 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls.some((a) => a.kind === "shell.exec")).toBe(true);
    expect(ctx.approveCalls.length).toBe(1);
  });
});
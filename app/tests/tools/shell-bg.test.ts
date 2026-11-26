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
    beginBackgroundCapture({
      pid: 999_999,
      sessionId: ctx.sessionId,
      command: "sleep 9",
      cwd: ctx.cwd,
      logPath: `${ctx.cwd}/bg3.log`,
      initialOutput: "",
      startedAtMs: Date.now(),
    });
    const r = await shellBgTool.execute({ op: "kill", pid: 999_999 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls.some((a) => a.kind === "shell.exec")).toBe(true);
    expect(ctx.approveCalls.length).toBe(1);
  });

  // D-3: a pid is only killable when it is a capture row owned by THIS session.
  test("kill refuses a pid that belongs to another session and signals nothing", async () => {
    const ctx = mockToolContext({ sessionId: "sess-a" });
    beginBackgroundCapture({
      pid: 9003,
      sessionId: "sess-b",
      command: "sleep 9",
      cwd: ctx.cwd,
      logPath: `${ctx.cwd}/bg4.log`,
      initialOutput: "",
      startedAtMs: Date.now(),
    });
    const r = await shellBgTool.execute({ op: "kill", pid: 9003 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("another session");
    // No approval is ever requested for a foreign job.
    expect(ctx.approveCalls.length).toBe(0);
  });

  test("kill refuses an unregistered live pid and leaves it running", async () => {
    const ctx = mockToolContext({ sessionId: "sess-a" });
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    try {
      // Give the child a moment to exist.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const r = await shellBgTool.execute({ op: "kill", pid: child.pid }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("not an auto-backgrounded job");
      let alive = true;
      try {
        process.kill(child.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  test("list never prints another session's command lines", async () => {
    const ctx = mockToolContext({ sessionId: "sess-a" });
    beginBackgroundCapture({
      pid: 9004,
      sessionId: "sess-b",
      command: "echo TOP-SECRET-OTHER-SESSION",
      cwd: ctx.cwd,
      logPath: `${ctx.cwd}/bg5.log`,
      initialOutput: "",
      startedAtMs: Date.now(),
    });
    const r = await shellBgTool.execute({ op: "list" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain("TOP-SECRET-OTHER-SESSION");
  });
});
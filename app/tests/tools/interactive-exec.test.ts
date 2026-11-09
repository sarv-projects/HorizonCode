/**
 * `shell_session` — the additive interactive PTY exec tool.
 *
 * Every test exercises interactive-exec.ts directly (session round-trips, the
 * codex output format, the session cap, timeouts, clean kills, guard admission,
 * and the pure PTY-capability helper), so each fails if the implementation is
 * reverted. The piped fallback is the always-works headless path and is the one
 * driven for the live round-trips; the PTY-vs-piped choice is covered through
 * the pure, injectable `canUseInteractivePty` helper.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { admissionFor, concurrencyClassOf, guardActionFor, SESSION_STATE_TOOLS } from "../../src/core/loop";
import {
  canUseInteractivePty,
  interactiveExecTool,
  liveSessionCount,
  resetSessionsForTest,
  sessionArgv,
} from "../../src/tools/interactive-exec";
import { makeWorkspace, mockToolContext } from "./helpers";

/** Force the piped fallback so the live round-trips are deterministic headless. */
function withNoPty(fn: () => Promise<void>): Promise<void> {
  const before = process.env.HZ_NO_PTY;
  process.env.HZ_NO_PTY = "1";
  return (async () => {
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.HZ_NO_PTY;
      else process.env.HZ_NO_PTY = before;
    }
  })();
}

afterEach(() => {
  resetSessionsForTest();
});

describe("shell_session: session round-trip (piped fallback)", () => {
  test("start cat, write_stdin, read the echo, then close removes the session", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const start = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
      expect(start.ok).toBe(true);
      expect(start.output).toContain("Status: running");
      const idMatch = start.output.match(/Session: (\S+)/);
      expect(idMatch).not.toBeNull();
      const sessionId = (idMatch as RegExpMatchArray)[1];
      expect(liveSessionCount()).toBe(1);

      const wrote = await interactiveExecTool.execute({ mode: "write", sessionId, input: "ping-me\n" }, ctx);
      expect(wrote.ok).toBe(true);
      expect(wrote.output).toContain("ping-me");
      expect(wrote.output).toContain("Output:");

      const closed = await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
      expect(closed.ok).toBe(true);
      expect(closed.output).toContain("closed");
      expect(liveSessionCount()).toBe(0);

      // The session is gone: a second write cannot find it.
      const again = await interactiveExecTool.execute({ mode: "write", sessionId, input: "x\n" }, ctx);
      expect(again.ok).toBe(false);
      expect(again.error).toContain("no such session");
    });
  });
});

describe("shell_session: codex output format", () => {
  test("a short command that exits reports Exit code / Wall time / Output, no Total output lines", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const r = await interactiveExecTool.execute({ mode: "start", command: "echo hello" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toMatch(/Exit code: 0/);
      expect(r.output).toMatch(/Wall time: \d+\.\d+s/);
      expect(r.output).toContain("Output:");
      expect(r.output).toContain("hello");
      // Small output is NOT truncated, so the line must be absent.
      expect(r.output).not.toContain("Total output lines:");
      expect(liveSessionCount()).toBe(0);
    });
  });

  test("a high-volume command truncates and reports Total output lines", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      // ~40k lines of "x" far exceeds the 30_000-char buffer cap.
      const r = await interactiveExecTool.execute(
        { mode: "start", command: "for i in $(seq 1 40000); do echo xxxxxxxxxx; done" },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain("Total output lines:");
      expect(r.output).toContain("Output:");
    });
  });
});

describe("shell_session: session cap", () => {
  test("starting more than the limit is refused and spawns nothing extra", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const ids: string[] = [];
      // Fill the registry with long-lived (sleeping-reader) sessions.
      for (let i = 0; i < 4; i += 1) {
        const r = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
        expect(r.ok).toBe(true);
        const id = (r.output.match(/Session: (\S+)/) as RegExpMatchArray)[1];
        ids.push(id);
      }
      expect(liveSessionCount()).toBe(4);

      const over = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
      expect(over.ok).toBe(false);
      expect(over.error).toContain("session limit reached");
      // Nothing extra spawned: still exactly the cap, and the guard was asked
      // for the over-the-limit command (admission precedes the cap check).
      expect(liveSessionCount()).toBe(4);

      for (const id of ids) await interactiveExecTool.execute({ mode: "close", sessionId: id }, ctx);
      expect(liveSessionCount()).toBe(0);
    });
  });
});

describe("shell_session: timeout", () => {
  test("a session that sleeps past the overall timeout is killed and reported", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const started = Date.now();
      const r = await interactiveExecTool.execute({ mode: "start", command: "sleep 30", timeoutMs: 300 }, ctx);
      // The start returns while the command is still running (SETTLE_MS < 30s).
      expect(r.ok).toBe(true);
      const sessionId = (r.output.match(/Session: (\S+)/) as RegExpMatchArray)[1];
      // Wait past the timeout; the watchdog kills the session.
      await new Promise((resolve) => setTimeout(resolve, 900));
      const after = await interactiveExecTool.execute({ mode: "write", sessionId, input: "" }, ctx);
      expect(after.ok).toBe(true);
      // Reported as exited (killed) within a few seconds, not after 30s.
      expect(after.output).toMatch(/Exit code:|Signal:/);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(liveSessionCount()).toBe(0);
    });
  });
});

describe("shell_session: clean kill", () => {
  test("close terminates the child process group", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const r = await interactiveExecTool.execute({ mode: "start", command: "sleep 30" }, ctx);
      expect(r.ok).toBe(true);
      const sessionId = (r.output.match(/Session: (\S+)/) as RegExpMatchArray)[1];
      expect(liveSessionCount()).toBe(1);

      const closed = await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
      expect(closed.ok).toBe(true);
      expect(closed.output).toContain("terminated");
      expect(liveSessionCount()).toBe(0);
    });
  });
});

describe("shell_session: guard admission", () => {
  test("a deny refuses WITHOUT spawning", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ decision: "deny", decisionReason: "sessions disabled" });
      const r = await interactiveExecTool.execute({ mode: "start", command: "echo nope" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("denied by policy: sessions disabled");
      expect(ctx.guardCalls).toEqual([{ kind: "shell.exec", target: "echo nope" }]);
      expect(ctx.approveCalls.length).toBe(0);
      expect(liveSessionCount()).toBe(0);
    });
  });

  test("an ask decline refuses and an ask approve proceeds", async () => {
    await withNoPty(async () => {
      const declineCtx = mockToolContext({ decision: "ask", approve: false });
      const declined = await interactiveExecTool.execute({ mode: "start", command: "echo hi" }, declineCtx);
      expect(declined.ok).toBe(false);
      expect(declined.error).toBe("declined by user");
      expect(declineCtx.approveCalls[0]).toEqual({ title: "Run interactive command", detail: "echo hi", kind: "shell.exec" });
      expect(liveSessionCount()).toBe(0);

      const approveCtx = mockToolContext({ decision: "ask", approve: true });
      const approved = await interactiveExecTool.execute({ mode: "start", command: "echo hi" }, approveCtx);
      expect(approved.ok).toBe(true);
      expect(approved.output).toContain("hi");
      expect(approveCtx.approveCalls.length).toBe(1);
      expect(liveSessionCount()).toBe(0);
    });
  });

  test("an already-aborted signal never spawns and never guards", async () => {
    const ctx = mockToolContext({ aborted: true });
    const r = await interactiveExecTool.execute({ mode: "start", command: "echo hi" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted");
    expect(ctx.guardCalls.length).toBe(0);
    expect(liveSessionCount()).toBe(0);
  });
});

describe("canUseInteractivePty (pure helper) + argv selection", () => {
  test("true when a backend is available and HZ_NO_PTY is unset", () => {
    expect(canUseInteractivePty({ backendAvailable: true, noPtyEnv: undefined })).toBe(true);
  });

  test("false when HZ_NO_PTY === '1' even if a backend is available", () => {
    expect(canUseInteractivePty({ backendAvailable: true, noPtyEnv: "1" })).toBe(false);
  });

  test("false when the backend is absent", () => {
    expect(canUseInteractivePty({ backendAvailable: false, noPtyEnv: undefined })).toBe(false);
  });

  test("argv selection: PTY uses util-linux script; piped uses bash -lc", () => {
    expect(sessionArgv("echo hi", true)).toEqual(["script", "-qec", "echo hi", "/dev/null"]);
    expect(sessionArgv("echo hi", false)).toEqual(["bash", "-lc", "echo hi"]);
  });
});

describe("shell_session: loop integration (admission + concurrency)", () => {
  test("concurrencyClass is exclusive (R-tools-39)", () => {
    expect(interactiveExecTool.concurrencyClass).toBe("exclusive");
    expect(concurrencyClassOf("shell_session")).toBe("exclusive");
  });

  test("start admits as shell.exec; write and close are session-state", () => {
    const start = guardActionFor("shell_session", { mode: "start", command: "echo hi" }, "/ws");
    expect(start).toEqual({ kind: "shell.exec", target: "echo hi" });

    // write/close carry no command and never start a process: session-state.
    expect(guardActionFor("shell_session", { mode: "write", sessionId: "x", input: "y" }, "/ws")).toBeUndefined();
    expect(guardActionFor("shell_session", { mode: "close", sessionId: "x" }, "/ws")).toBeUndefined();
    expect(SESSION_STATE_TOOLS).toContain("shell_session");

    // Either way the tool has a defined admission (never fail-closed-unmapped).
    expect(admissionFor("shell_session", { mode: "start", command: "echo hi" }, "/ws")).toEqual({
      kind: "guard",
      action: { kind: "shell.exec", target: "echo hi" },
    });
    expect(admissionFor("shell_session", { mode: "write", sessionId: "x" }, "/ws")).toEqual({ kind: "session-state" });
  });
});

describe("shell_session: PTY integration (when a backend is obtainable)", () => {
  test("forcing the PTY path, the child sees a real tty", async () => {
    // Only run when util-linux `script` is present and a pty is obtainable.
    if (Bun.which("script") === null) return;
    const before = process.env.HZ_NO_PTY;
    if (before !== undefined) delete process.env.HZ_NO_PTY;
    try {
      const ctx = mockToolContext({ cwd: makeWorkspace() });
      const r = await interactiveExecTool.execute({ mode: "start", command: "tty" }, ctx);
      expect(r.ok).toBe(true);
      // `tty` prints the controlling terminal: a /dev/pts entry under a real pty.
      expect(r.output).toContain("/dev/pts/");
    } finally {
      if (before !== undefined) process.env.HZ_NO_PTY = before;
    }
  });
});

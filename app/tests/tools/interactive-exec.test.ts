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
  rawForSpillLengthForTest,
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

  test(
    "a high-volume command truncates and reports Total output lines",
    async () => {
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
    },
    120_000,
  );
});

describe("shell_session: raw-spill capture is scoped per read window", () => {
  test("rawForSpill is reset on every read, so it never accumulates across the session", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      // A persistent `cat` echoes each write; every read drains the buffer.
      const start = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
      expect(start.ok).toBe(true);
      const sessionId = (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1];

      // First burst: write, read back, and the raw capture must be cleared.
      const first = await interactiveExecTool.execute({ mode: "write", sessionId, input: "alpha-line\n" }, ctx);
      expect(first.ok).toBe(true);
      expect(first.output).toContain("alpha-line");
      expect(rawForSpillLengthForTest(sessionId)).toBe(0);

      // Second burst: the prior burst's bytes must NOT carry forward. The raw
      // capture reflects only this read window, proving it is bounded/scoped.
      const second = await interactiveExecTool.execute({ mode: "write", sessionId, input: "beta-line\n" }, ctx);
      expect(second.ok).toBe(true);
      expect(second.output).toContain("beta-line");
      expect(second.output).not.toContain("alpha-line");
      expect(rawForSpillLengthForTest(sessionId)).toBe(0);

      await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
      expect(liveSessionCount()).toBe(0);
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
      const r = await interactiveExecTool.execute({ mode: "start", command: "sleep 1000", timeoutMs: 300 }, ctx);
      // The start returns while the command is still running (settle window < process lifetime).
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

describe("shell_session: write is admitted per input line (start approval does not cover input)", () => {
  /** Start `cat` (a stdin reader) with an allowing start, then return its id. */
  async function startCat(ctx: ReturnType<typeof mockToolContext>): Promise<string> {
    const start = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
    expect(start.ok).toBe(true);
    return (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1] as string;
  }

  test("approving the start does NOT authorize a later `rm -rf x`: a deny rule refuses and nothing is written", async () => {
    await withNoPty(async () => {
      const ws = makeWorkspace({ "x/keep.txt": "keep" });
      const ctx = mockToolContext({
        cwd: ws,
        decision: (a) => (a.target.startsWith("rm ") ? { decision: "deny", reason: "rm is denied" } : { decision: "allow" }),
      });
      const sessionId = await startCat(ctx);
      const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: "rm -rf x\n" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("denied by policy: rm is denied");
      expect(ctx.guardCalls.at(-1)).toEqual({ kind: "shell.exec", target: "rm -rf x" });
      // Nothing reached stdin: cat has echoed nothing.
      const probe = await interactiveExecTool.execute({ mode: "write", sessionId, input: "" }, ctx);
      expect(probe.output).not.toContain("rm -rf");
    });
  });

  test("an ask prompts with the session command + input; approve writes, decline writes nothing", async () => {
    await withNoPty(async () => {
      const askRm = (a: { target: string }) => (a.target.startsWith("rm ") ? ({ decision: "ask" } as const) : ({ decision: "allow" } as const));
      const declineCtx = mockToolContext({ decision: askRm, approve: false });
      const id1 = await startCat(declineCtx);
      const declined = await interactiveExecTool.execute({ mode: "write", sessionId: id1, input: "rm -rf x\n" }, declineCtx);
      expect(declined.ok).toBe(false);
      expect(declined.error).toBe("declined by user");
      expect(declineCtx.approveCalls.at(-1)).toEqual({
        title: "Send input to interactive session",
        detail: "cat <- rm -rf x",
        kind: "shell.exec",
      });
      const probe = await interactiveExecTool.execute({ mode: "write", sessionId: id1, input: "" }, declineCtx);
      expect(probe.output).not.toContain("rm -rf");

      const okCtx = mockToolContext({ decision: askRm, approve: true });
      const id2 = await startCat(okCtx);
      const approved = await interactiveExecTool.execute({ mode: "write", sessionId: id2, input: "rm -rf x\n" }, okCtx);
      expect(approved.ok).toBe(true);
      expect(approved.output).toContain("rm -rf x"); // cat echoed it (never executed by a shell)
      expect(okCtx.approveCalls.length).toBe(1);
    });
  });

  test("every line of a multi-line write is admitted; one denied line refuses the whole write", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ decision: (a) => (a.target === "bad" ? { decision: "deny" } : { decision: "allow" }) });
      const sessionId = await startCat(ctx);
      const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: "good\nbad\n" }, ctx);
      expect(r.ok).toBe(false);
      expect(ctx.guardCalls.map((a) => a.target)).toEqual(["cat", "good", "bad"]);
      const probe = await interactiveExecTool.execute({ mode: "write", sessionId, input: "" }, ctx);
      expect(probe.output).not.toContain("good");
    });
  });

  test("a command split across writes is admitted as the joined line", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ decision: (a) => (a.target === "rm -rf x" ? { decision: "deny" } : { decision: "allow" }) });
      const sessionId = await startCat(ctx);
      expect((await interactiveExecTool.execute({ mode: "write", sessionId, input: "rm -rf" }, ctx)).ok).toBe(true);
      const second = await interactiveExecTool.execute({ mode: "write", sessionId, input: " x\n" }, ctx);
      expect(second.ok).toBe(false);
      expect(ctx.guardCalls.at(-1)).toEqual({ kind: "shell.exec", target: "rm -rf x" });
    });
  });

  test("the approval names the exact input as the action, so an always grant is exact-input only", async () => {
    await withNoPty(async () => {
      const seen: Array<{ target: string }> = [];
      const ctx = mockToolContext({ decision: (a) => (a.target === "cat" ? { decision: "allow" } : { decision: "ask" }) });
      const origApprove = ctx.approve.bind(ctx);
      ctx.approve = async (req, action) => {
        if (action !== undefined) seen.push(action);
        return origApprove(req);
      };
      const sessionId = await startCat(ctx);
      await interactiveExecTool.execute({ mode: "write", sessionId, input: "echo hi\n" }, ctx);
      // The only action an `always` answer can be scoped to is this exact line.
      expect(seen).toEqual([{ kind: "shell.exec", target: "echo hi" }]);
    });
  });

  test("blank input (a bare Enter) needs no admission and still reaches a stdin reader", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext();
      const sessionId = await startCat(ctx);
      const before = ctx.guardCalls.length;
      const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: "\n" }, ctx);
      expect(r.ok).toBe(true);
      expect(ctx.guardCalls.length).toBe(before);
    });
  });
});

describe("shell_session: control characters and incomplete lines", () => {
  async function startCat(ctx: ReturnType<typeof mockToolContext>): Promise<string> {
    const start = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
    return (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1] as string;
  }

  test("input with line-editing control characters is refused and nothing is guarded or written", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ cwd: makeWorkspace() });
      const sessionId = await startCat(ctx);
      const before = ctx.guardCalls.length;
      for (const input of ["ls\x15rm -rf x\n", "a\x7fb\n", "x\x03\n", "\x1b[Ahi\n", "q\x17\n", "\x04"]) {
        const r = await interactiveExecTool.execute({ mode: "write", sessionId, input }, ctx);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("control characters");
      }
      expect(ctx.guardCalls.length).toBe(before);
      expect((await interactiveExecTool.execute({ mode: "write", sessionId, input: "tab\there\n" }, ctx)).ok).toBe(true);
    });
  });

  test("an unterminated fragment is not admitted or prompted; the completed line is, once", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ decision: (a) => (a.target === "cat" ? { decision: "allow" } : { decision: "ask" }), approve: true });
      const sessionId = await startCat(ctx);
      await interactiveExecTool.execute({ mode: "write", sessionId, input: "rm -r" }, ctx);
      expect(ctx.approveCalls.length).toBe(0);
      await interactiveExecTool.execute({ mode: "write", sessionId, input: "f x\n" }, ctx);
      expect(ctx.approveCalls.length).toBe(1);
      expect(ctx.guardCalls.at(-1)).toEqual({ kind: "shell.exec", target: "rm -rf x" });
    });
  });

  test("a long line is shown whole in the prompt and the guard target is exact; over 4000 is refused", async () => {
    await withNoPty(async () => {
      const ctx = mockToolContext({ decision: (a) => (a.target === "cat" ? { decision: "allow" } : { decision: "ask" }), approve: true });
      const sessionId = await startCat(ctx);
      const long = "p".repeat(3000) + "; tail-marker";
      await interactiveExecTool.execute({ mode: "write", sessionId, input: long + "\n" }, ctx);
      expect(ctx.approveCalls.at(-1)?.detail).toContain(long);
      expect(ctx.guardCalls.at(-1)?.target).toBe(long);
      const before = ctx.guardCalls.length;
      const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: "x".repeat(4001) + "\n" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("too long");
      expect(ctx.guardCalls.length).toBe(before);
      // 2000 CJK chars = 6000 UTF-8 bytes: under 4000 characters but over the tty byte limit.
      const cjk = await interactiveExecTool.execute({ mode: "write", sessionId, input: "\u6f22".repeat(2000) + "\n" }, ctx);
      expect(cjk.ok).toBe(false);
      expect(cjk.error).toContain("too long");
      expect(ctx.guardCalls.length).toBe(before);
    });
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

describe("shell_session: guard on the real PTY path with a real bash", () => {
  test("typed commands are admitted per line and control-character edits are refused", async () => {
    if (Bun.which("script") === null) return;
    const before = process.env.HZ_NO_PTY;
    delete process.env.HZ_NO_PTY;
    try {
      const ws = makeWorkspace({ "x/keep.txt": "keep" });
      const ctx = mockToolContext({
        cwd: ws,
        decision: (a) => (a.target.startsWith("rm ") ? { decision: "deny", reason: "rm is denied" } : { decision: "allow" }),
      });
      const start = await interactiveExecTool.execute({ mode: "start", command: "bash --norc --noprofile -i" }, ctx);
      expect(start.ok).toBe(true);
      const sessionId = (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1] as string;
      const edited = await interactiveExecTool.execute({ mode: "write", sessionId, input: "ls\x15rm -rf x\n" }, ctx);
      expect(edited.ok).toBe(false);
      expect(edited.error).toContain("control characters");
      const denied = await interactiveExecTool.execute({ mode: "write", sessionId, input: "rm -rf x\n" }, ctx);
      expect(denied.error).toBe("denied by policy: rm is denied");
      const ok = await interactiveExecTool.execute({ mode: "write", sessionId, input: "echo pty-ok-$((20+22))\n" }, ctx);
      expect(ok.ok).toBe(true);
      await Bun.sleep(300);
      const out = await interactiveExecTool.execute({ mode: "write", sessionId, input: "" }, ctx);
      expect(ok.output + out.output).toContain("pty-ok-42");
      expect(require("node:fs").existsSync(ws + "/x/keep.txt")).toBe(true);
    } finally {
      if (before !== undefined) process.env.HZ_NO_PTY = before;
    }
  });
});

describe("shell_session: bare CR cannot join two admitted lines (pipe mode)", () => {
  test("CR is normalized to a newline so executed lines equal admitted lines", async () => {
    await withNoPty(async () => {
      const ws = makeWorkspace({});
      const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
      const start = await interactiveExecTool.execute({ mode: "start", command: "bash --norc --noprofile" }, ctx);
      const sessionId = (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1] as string;
      const first = await interactiveExecTool.execute({ mode: "write", sessionId, input: "echo AAA\r" }, ctx);
      const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: "echo BBB\n" }, ctx);
      await Bun.sleep(300);
      const out = first.output + r.output + (await interactiveExecTool.execute({ mode: "write", sessionId, input: "" }, ctx)).output;
      expect(out).toContain("AAA");
      expect(out).toContain("BBB");
      expect(out).not.toContain("AAA\recho");
      await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
    });
  });
});

describe("shell_session: invisible Unicode and per-write ceilings", () => {
  async function startBash(ctx: ReturnType<typeof mockToolContext>): Promise<string> {
    const start = await interactiveExecTool.execute({ mode: "start", command: "bash --norc --noprofile" }, ctx);
    return (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1] as string;
  }

  test("bidi, zero-width and line-separator characters are refused before the guard", async () => {
    await withNoPty(async () => {
      const ws = makeWorkspace({});
      let calls = 0;
      const ctx = mockToolContext({ cwd: ws, decision: () => (calls++, { decision: "allow" }) });
      const sessionId = await startBash(ctx);
      const before = calls;
      for (const ch of ["\u202e", "\u2066", "\u200b", "\u2060", "\ufeff", "\u2028", "\u2029", "\u200f"]) {
        const r = await interactiveExecTool.execute({ mode: "write", sessionId, input: `echo a${ch}b\n` }, ctx);
        expect(r.ok).toBe(false);
        expect(r.error ?? "").toContain("invisible or direction-changing Unicode");
      }
      expect(calls).toBe(before);
      await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
    });
  });

  test("start refuses an invisible-Unicode command before the guard", async () => {
    const ws = makeWorkspace({});
    let calls = 0;
    const ctx = mockToolContext({ cwd: ws, decision: () => (calls++, { decision: "allow" }) });
    const r = await interactiveExecTool.execute({ mode: "start", command: "echo a\u202eb" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toContain("invisible or direction-changing Unicode");
    expect(calls).toBe(0);
  });

  test("more than 64 lines or 64 KiB in one write is refused before the guard", async () => {
    await withNoPty(async () => {
      const ws = makeWorkspace({});
      let calls = 0;
      const ctx = mockToolContext({ cwd: ws, decision: () => (calls++, { decision: "allow" }) });
      const sessionId = await startBash(ctx);
      const before = calls;
      const many = await interactiveExecTool.execute({ mode: "write", sessionId, input: "true\n".repeat(65) }, ctx);
      expect(many.ok).toBe(false);
      expect(many.error ?? "").toContain("too large for one write");
      const big = await interactiveExecTool.execute({ mode: "write", sessionId, input: ("#" + "x".repeat(3000) + "\n").repeat(22) }, ctx);
      expect(big.ok).toBe(false);
      expect(big.error ?? "").toContain("too large for one write");
      expect(calls).toBe(before);
      const ok = await interactiveExecTool.execute({ mode: "write", sessionId, input: "true\n".repeat(64) }, ctx);
      expect(ok.ok).toBe(true);
      await interactiveExecTool.execute({ mode: "close", sessionId }, ctx);
    });
  });
});

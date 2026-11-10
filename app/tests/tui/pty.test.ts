/**
 * pty.test.ts — the chat bar a human actually sees.
 *
 * Interactive mode only exists when stdin is a terminal, so the app has to be
 * run under a pty (util-linux `script`). Where `script` is missing the file
 * skips with a message instead of failing: a pipe would just run headless.
 *
 * Each step waits for the line it expects before typing the next one, so the
 * transcript is judged in order even though a pty interleaves the echo of what
 * was typed with what the app prints.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { MOCK_GREETING, MOCK_LOOKING } from "../../src/core/providers/mock";
import { shortenPath } from "../../src/tui/banner";
import {
  APP_DIR,
  BUN_BIN,
  createWorkspacePool,
  flatten,
  killAllProcesses,
  shellQuote,
  spawnProcess,
  waitFor,
} from "./harness";

/** A pty run needs room to start, answer and leave. */
const PTY_TIMEOUT_MS = 25_000;
/** The guard consults this policy: a workspace read has to be approved. */
const ASK_POLICY = JSON.stringify([{ kind: "fs.read", scope: "workspace", decision: "ask" }]);

function findScript(): string | null {
  try {
    const probe = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
    const found = String(probe.stdout ?? "").trim();
    return probe.status === 0 && found !== "" ? found : null;
  } catch {
    return null;
  }
}

const SCRIPT = findScript();
const pool = createWorkspacePool();

afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

/** Start `hzcode` inside a pty, with the pty's input coming from our pipe. */
function startChat(workspace: string, env: Record<string, string> = { NO_COLOR: "1" }) {
  const command = [
    "exec",
    shellQuote(BUN_BIN),
    "run",
    shellQuote(path.join(APP_DIR, "src", "main.ts")),
    "--workspace",
    shellQuote(workspace),
    "--mock",
  ].join(" ");
  return spawnProcess({
    file: SCRIPT as string,
    args: ["-qec", command, "/dev/null"],
    cwd: APP_DIR,
    env: { ...env, TERM: "xterm-256color" },
    timeoutMs: PTY_TIMEOUT_MS,
  });
}

if (!SCRIPT) {
  test.skip("chat bar: banner, an answer, /help and a tool card (needs util-linux `script`)", () => {});
  test.skip("chat bar: /model, /files and an unknown command (needs util-linux `script`)", () => {});
  test.skip("chat bar: a human denies once and approves the next time (needs util-linux `script`)", () => {});
  test.skip("chat bar: /context reports the window and the estimated input (needs util-linux `script`)", () => {});
} else {
  test(
    "prints the banner, answers a line, shows /help, then leaves on Ctrl-D with exit 0",
    async () => {
      const ws = pool.make({ "alpha.txt": "alpha\n" });
      const proc = startChat(ws);

      proc.write("hello\n");
      expect(await waitFor(proc, MOCK_GREETING)).toBe(true);

      proc.write("/help\n");
      expect(await waitFor(proc, "tools the assistant can use")).toBe(true);

      proc.write("list files\n");
      expect(await waitFor(proc, "\u23fa glob(")).toBe(true);

      // Ctrl-D: the End-of-Transmission byte, the way a human leaves.
      proc.write("\u0004");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false); // it left on its own
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);

      // the banner: who is running, where, and under which kernel
      expect(out).toContain("HzCode");
      expect(out).toContain(`workspace ${shortenPath(ws)}`);
      expect(out).toMatch(/kernel (trusted|untrusted)/);

      // the chat bar and the answer to the first line
      expect(out).toContain("\u276f");
      expect(out).toContain(MOCK_GREETING);
      expect(out).toContain(MOCK_LOOKING);

      // the /help output
      expect(out).toContain("/new");
      expect(out).toContain("/files");
      expect(out).toContain("tools the assistant can use");
      expect(out).toContain("/exit");

      // in order: answer, help text, tool card
      expect(out.indexOf(MOCK_GREETING)).toBeLessThan(out.indexOf("tools the assistant can use"));
      expect(out.indexOf("tools the assistant can use")).toBeLessThan(out.indexOf("\u23fa glob("));
    },
    PTY_TIMEOUT_MS + 5_000,
  );

  test(
    "runs /model, /files and reports an unknown command",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws);

      proc.write("/model\n");
      // the notice line (a bullet), not the banner's model line
      expect(await waitFor(proc, "\u00b7 model mock-1")).toBe(true);

      proc.write("/files\n");
      expect(await waitFor(proc, /tools \(\d+ registered\): \d+ available now: /)).toBe(true);

      proc.write("/nope\n");
      expect(await waitFor(proc, "unknown command /nope")).toBe(true);

      // /exit leaves the chat bar too, and just as cleanly as Ctrl-D.
      proc.write("/exit\n");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(0);
      // the tool list names real tools and stays in order
      expect(out).toMatch(/tools \(\d+ registered\): [\s\S]*glob/);
      expect(out).toMatch(/tools \(\d+ registered\): [\s\S]*shell/);
      expect(out.indexOf("\u00b7 model mock-1")).toBeLessThan(out.indexOf("tools ("));
      expect(out.indexOf("tools (")).toBeLessThan(out.indexOf("unknown command /nope"));
    },
    PTY_TIMEOUT_MS + 5_000,
  );

  test(
    "/context reports the window and the estimated input after a turn",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws);

      // Before any dispatch there is nothing to report, and it says so.
      proc.write("/context\n");
      expect(await waitFor(proc, "no context snapshot yet")).toBe(true);

      proc.write("hello\n");
      expect(await waitFor(proc, MOCK_GREETING)).toBe(true);

      proc.write("/context\n");
      expect(await waitFor(proc, "context \u00b7 model mock-1")).toBe(true);

      proc.write("/exit\n");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(0);
      // Harness-side numbers, in one line: window, estimate, output cap, view.
      // The pty may wrap the line, so each number is asserted on its own.
      expect(out).toMatch(/window \d+ tok/);
      expect(out).toMatch(/estimated input \d+ tok \(\d+%\)/);
      expect(out).toMatch(/output cap \d+ tok/);
      expect(out).toMatch(/\d+\/\d+ messages in view/);
      expect(out.indexOf("no context snapshot yet")).toBeLessThan(out.indexOf("context \u00b7 model mock-1"));
    },
    PTY_TIMEOUT_MS + 5_000,
  );

  test(
    "asks before a guarded action: no denies the tool, yes lets it run",
    async () => {
      const ws = pool.make({ "alpha.txt": "alpha\n", ".hzcode/kernel/policy.json": ASK_POLICY });
      const proc = startChat(ws);

      // first turn: the human says no
      proc.write("list files\n");
      expect(await waitFor(proc, "Approve read")).toBe(true);
      proc.write("n\n");
      expect(await waitFor(proc, "DECLINED by the user")).toBe(true);
      expect(await waitFor(proc, "\u00b7 denied")).toBe(true);

      // second turn: the same action, this time approved
      proc.write("list files\n");
      expect(await waitFor(proc, "Approve read", { count: 2 })).toBe(true);
      proc.write("y\n");
      expect(await waitFor(proc, "\u00b7 approved (this time)")).toBe(true);
      expect(await waitFor(proc, "ok: alpha.txt")).toBe(true);

      proc.write("\u0004");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(0);
      // the refusal came first, the real listing only after the yes
      expect(out.indexOf("DECLINED by the user")).toBeLessThan(out.indexOf("ok: alpha.txt"));
      expect(out).toContain("\u23fa glob(");
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}

if (SCRIPT) {
  test(
    "a bracketed multi-line paste is one input shown as [pasted N lines]",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws);
      expect(await waitFor(proc, "\u276f")).toBe(true);

      proc.write("\u001b[200~first line\nsecond line\nthird line\u001b[201~\n");
      expect(await waitFor(proc, "[pasted 3 lines]")).toBe(true);
      expect(await waitFor(proc, MOCK_GREETING)).toBe(true);

      proc.write("\u0004");
      const run = await proc.done;
      expect(run.code).toBe(0);
    },
    PTY_TIMEOUT_MS + 5_000,
  );

  test(
    "rich mode: the approval card is answered by one key, Enter and type-ahead never approve",
    async () => {
      const ws = pool.make({ "alpha.txt": "alpha\n", ".hzcode/kernel/policy.json": ASK_POLICY });
      const proc = startChat(ws, { NO_COLOR: "", FORCE_COLOR: "1", LANG: "en_US.UTF-8" });

      proc.write("list files\n");
      expect(await waitFor(proc, "Approve read")).toBe(true);
      expect(await waitFor(proc, "always this session")).toBe(true);
      // Enter is a denial, not a yes
      await new Promise((r) => setTimeout(r, 400));
      proc.write("\r");
      expect(await waitFor(proc, "DECLINED by the user")).toBe(true);

      proc.write("list files\n");
      expect(await waitFor(proc, "Approve read", { count: 2 })).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      proc.write("y"); // no Enter
      expect(await waitFor(proc, "\u00b7 approved (this time)")).toBe(true);
      expect(await waitFor(proc, "1 tool")).toBe(true);

      proc.write("\u0004");
      const run = await proc.done;
      const out = flatten(run.stdout);
      expect(run.code).toBe(0);
      expect(out).toContain("\u256d"); // the card border
      expect(out).toContain("risk");
    },
    PTY_TIMEOUT_MS + 5_000,
  );

  test(
    "rich mode: streamed reasoning collapses to a Thought line and /think expands it",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws, { NO_COLOR: "", FORCE_COLOR: "1", LANG: "en_US.UTF-8" });
      proc.write("think hard about this\n");
      expect(await waitFor(proc, "Thought for")).toBe(true);
      expect(await waitFor(proc, MOCK_GREETING)).toBe(true);
      proc.write("/think\n");
      expect(await waitFor(proc, "I can simply greet them.")).toBe(true);
      proc.write("\u0004");
      const run = await proc.done;
      expect(run.code).toBe(0);
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}


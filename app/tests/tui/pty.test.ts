/**
 * pty.test.ts — the chat bar a human actually sees.
 *
 * Interactive mode only exists when stdin is a terminal, so the app has to be
 * run under a pty (util-linux `script`). Where `script` is missing the whole
 * test skips with a message instead of failing: a pipe would just run headless.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { MOCK_GREETING } from "../../src/core/providers/mock";
import { shortenPath } from "../../src/tui/banner";
import {
  APP_DIR,
  BUN_BIN,
  createWorkspacePool,
  flatten,
  killAllProcesses,
  shellQuote,
  sleep,
  spawnProcess,
} from "./harness";

/** Give the pty run a little more room than the headless ones. */
const PTY_TIMEOUT_MS = 25_000;

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

if (!SCRIPT) {
  test.skip("interactive chat bar over a PTY (needs util-linux `script`, which is not installed)", () => {});
} else {
  test(
    "prints the banner, answers a line, shows /help and exits 0 on Ctrl-D",
    async () => {
      const ws = pool.make();
      const command = [
        "exec",
        shellQuote(BUN_BIN),
        "run",
        shellQuote(path.join(APP_DIR, "src", "main.ts")),
        "--workspace",
        shellQuote(ws),
        "--mock",
      ].join(" ");

      const proc = spawnProcess({
        file: SCRIPT,
        args: ["-qec", command, "/dev/null"],
        cwd: APP_DIR,
        env: { NO_COLOR: "1", TERM: "xterm-256color" },
        timeoutMs: PTY_TIMEOUT_MS,
      });

      // One line at a time, so each turn lands before the next one is typed.
      proc.write("hello\n");
      await sleep(700);
      proc.write("/help\n");
      await sleep(700);
      proc.write("list files\n");
      await sleep(700);
      // Ctrl-D: the End-of-Transmission byte, the way a human leaves the chat bar.
      proc.write("\u0004");

      const run = await proc.done;
      // PTY output interleaves and carries CRLF: judge it as flat text.
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false); // it left on Ctrl-D by itself
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);

      // the banner: who is running, where, and with which kernel
      expect(out).toContain("HzCode");
      expect(out).toContain(`workspace ${shortenPath(ws)}`);
      expect(out).toMatch(/kernel (trusted|untrusted)/);

      // the chat bar itself, and the answer to the first line
      expect(out).toContain("\u276f");
      expect(out).toContain(MOCK_GREETING);

      // /help printed the command list
      expect(out).toContain("/help");
      expect(out).toContain("/new");
      expect(out).toContain("/files");
      expect(out).toContain("tools the assistant can use");
      expect(out).toContain("/exit");

      // in order: the answer to "hello" came before the help text, which came
      // before the tool card of the third line
      expect(out.indexOf(MOCK_GREETING)).toBeLessThan(out.indexOf("tools the assistant can use"));
      expect(out.indexOf("tools the assistant can use")).toBeLessThan(out.indexOf("\u23fa glob("));
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}

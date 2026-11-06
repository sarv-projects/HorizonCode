/**
 * harness.test.ts — the safety net the other files rely on.
 *
 * If these fail, a hang in the app can hang the suite, so the harness proves its
 * own kill timer and its own stdin/stdout plumbing once, cheaply.
 */

import { describe, expect, test } from "bun:test";
import { runProcess, spawnProcess, waitFor } from "./harness";

describe("the spawn harness", () => {
  test("feeds stdin, collects stdout and reports the exit", async () => {
    const run = await runProcess({ file: "sh", args: ["-c", "cat"] }, "one\ntwo\n");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("one\ntwo\n");
  });

  test("kills a process that never exits and says so", async () => {
    const proc = spawnProcess({ file: "sh", args: ["-c", "printf started; sleep 30"], timeoutMs: 600 });
    expect(await waitFor(proc, "started", { timeoutMs: 500 })).toBe(true);

    const run = await proc.done;

    expect(run.timedOut).toBe(true);
    expect(run.stdout).toContain("started");
    expect(run.signal).toBe("SIGKILL");
  });
});

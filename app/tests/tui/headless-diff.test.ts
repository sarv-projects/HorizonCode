/**
 * headless-diff.test.ts — S1 P3: in headless mode a turn.diff is a one-line
 * summary on STDERR; stdout (the transcript) never carries the diff body.
 */

import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { Runtime } from "../../src/contracts";
import { runHeadless } from "../../src/tui/headless";

describe("headless turn.diff", () => {
  test("summary goes to stderr, diff body stays out of stdout", async () => {
    const runtime = {
      sessionId: "s",
      model: "m",
      providerName: "p",
      kernelMode: "trusted",
      abort() {},
      async close() {},
      async send(_t: string, cb: { onEvent(ev: unknown): void }) {
        cb.onEvent({ type: "assistant.done", text: "done" });
        cb.onEvent({ type: "turn.diff", turn: 1, files: 2, diff: "--- a\n+++ b\n+SECRETBODY" });
        cb.onEvent({ type: "turn.done" });
        return { text: "done", aborted: false, exit: { terminal: "completed" } };
      },
    } as unknown as Runtime;
    const out: string[] = [];
    const err: string[] = [];
    const ow = process.stdout.write.bind(process.stdout);
    const ew = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: unknown }).write = (c: string) => (out.push(String(c)), true);
    (process.stderr as unknown as { write: unknown }).write = (c: string) => (err.push(String(c)), true);
    try {
      await runHeadless({ runtime, initialMessage: "hi", input: Readable.from([]) });
    } finally {
      process.stdout.write = ow;
      process.stderr.write = ew;
    }
    expect(err.join("")).toContain("\u00b7 changed 2 files");
    expect(out.join("")).not.toContain("SECRETBODY");
    expect(out.join("")).not.toContain("changed 2 files");
  });
});

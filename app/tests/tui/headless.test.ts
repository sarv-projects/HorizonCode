/**
 * headless.test.ts — the piped-stdin chat loop (`echo "hi" | hzcode`).
 *
 * Everything here spawns the real entry point (src/main.ts) with a pipe on
 * stdin, a fresh temp workspace and the offline mock provider.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { MOCK_GREETING, MOCK_LOOKING } from "../../src/core/providers/mock";
import { appSpec, createWorkspacePool, headlessSpec, killAllProcesses, runApp, runHeadless } from "./harness";

const pool = createWorkspacePool();

afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

const PROMPT = "\u276f"; // ❯ the chat glyph that opens an echoed line
const CARD = "\u23fa"; // ⏺ a tool card while it is running
const CORNER = "\u2514"; // └ the result line under a card

/** The approval policy the guard reads: a workspace read now needs a human. */
const ASK_POLICY = JSON.stringify([{ kind: "fs.read", scope: "workspace", decision: "ask" }]);

describe("headless mode (stdin is a pipe)", () => {
  test("echoes the line, streams the mock reply and exits 0", async () => {
    const ws = pool.make();
    const run = await runHeadless(ws, "hello\n");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${PROMPT} hello`);
    expect(run.stdout).toContain(MOCK_GREETING);
    // the answer comes after the echo of the message it answers
    expect(run.stdout.indexOf(MOCK_GREETING)).toBeGreaterThan(run.stdout.indexOf(`${PROMPT} hello`));
    // a pipe gets plain text: no escape sequences on the way out
    expect(run.stdout).not.toContain("\u001b");
    expect(run.stderr).toBe("");
  });

  test("runs the tool loop: a glob card and an ok result line, then exit 0", async () => {
    const ws = pool.make({ "alpha.txt": "alpha\n" });
    const run = await runHeadless(ws, "list files\n");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(MOCK_LOOKING);
    // the card: one line, the tool name and its arguments
    expect(run.stdout).toMatch(new RegExp(`^${CARD} glob\\(`, "m"));
    // the result line: the corner glyph and the ok word under the card
    expect(run.stdout).toMatch(new RegExp(`^  ${CORNER} ok:`, "m"));
    // the tool really ran in the temp workspace
    expect(run.stdout).toContain("alpha.txt");
    // exactly one card for one tool call
    expect(run.stdout.split(`${CARD} glob(`).length - 1).toBe(1);
    expect(run.stdout.split(`${CORNER} `).length - 1).toBe(1);
  });

  test("processes two piped lines sequentially and answers both", async () => {
    const ws = pool.make({ "alpha.txt": "alpha\n" });
    const run = await runHeadless(ws, "hello\nlist files\n");

    expect(run.code).toBe(0);
    const firstEcho = run.stdout.indexOf(`${PROMPT} hello`);
    const firstReply = run.stdout.indexOf(MOCK_GREETING);
    const secondEcho = run.stdout.indexOf(`${PROMPT} list files`);
    const secondCard = run.stdout.indexOf(`${CARD} glob(`);
    expect(firstEcho).toBeGreaterThanOrEqual(0);
    // strictly interleaved: echo, reply, next echo, next reply
    expect(firstReply).toBeGreaterThan(firstEcho);
    expect(secondEcho).toBeGreaterThan(firstReply);
    expect(secondCard).toBeGreaterThan(secondEcho);
    expect(run.stdout).toContain("Mock mode: the glob tool returned");
    // two inputs, two replies: the greeting only answers the plain line
    expect(run.stdout.split(MOCK_GREETING).length - 1).toBe(1);
  });

  test("answers a final line that has no trailing newline", async () => {
    const ws = pool.make();
    const run = await runHeadless(ws, "hello");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${PROMPT} hello`);
    expect(run.stdout).toContain(MOCK_GREETING);
  });

  test("skips blank lines instead of sending them", async () => {
    const ws = pool.make();
    const run = await runHeadless(ws, "\n\nhello\n");

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${PROMPT} hello\n${MOCK_GREETING}\n`);
  });

  test("answers a message typed on the command line before reading stdin", async () => {
    const ws = pool.make();
    const run = await runApp({ ...headlessSpec(ws, ["hello"]), timeoutMs: 20_000 }, "");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${PROMPT} hello`);
    expect(run.stdout).toContain(MOCK_GREETING);
  });

  test("exits 0 with no output when stdin is already at EOF", async () => {
    const ws = pool.make();
    const run = await runApp(headlessSpec(ws), "");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });
});

describe("headless approvals fail closed", () => {
  test("an approval nobody can answer is denied, and the tool does not run", async () => {
    // This workspace's policy sends a workspace read to the guard as a question.
    const ws = pool.make({
      "alpha.txt": "alpha\n",
      ".hzcode/kernel/policy.json": ASK_POLICY,
    });
    const run = await runHeadless(ws, "list files\n");

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    // the request is announced, with the reason it is refused
    expect(run.stdout).toContain("approval requested (fs.read)");
    expect(run.stdout).toContain("denied, no one is attached to say yes");
    // and the tool reports the refusal instead of pretending it worked
    expect(run.stdout).toMatch(new RegExp(`^  ${CORNER} error: DECLINED by the user$`, "m"));
    // nothing was read: the summary is the refusal, not the file listing
    expect(run.stdout).toContain("First line: DECLINED by the user");
  });
});

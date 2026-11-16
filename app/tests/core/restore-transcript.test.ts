/**
 * restore-transcript.test.ts — E-4 product wire.
 *
 * Proves the three acceptance axes that the pure markdown-transcript unit tests
 * cannot: `--restore` / `RuntimeOptions.restoreFromTranscript` actually seeds
 * the SessionStore; a missing/corrupt transcript fails closed with a clear
 * notice; and continuous write is default-on (0600/0700) with a per-event file
 * that still parses and restores.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ChatMsg, RuntimeEvent } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import {
  countMarkdownMessageSections,
  formatMarkdownMessages,
  formatMarkdownTranscriptHeader,
  markdownTranscriptPath,
  parseMarkdownTranscript,
  resumeMessagesFromMarkdownTranscript,
} from "../../src/core/markdown-transcript";

const dirs: string[] = [];
let savedLatch: string | undefined;

beforeAll(() => {
  savedLatch = process.env.HZ_MARKDOWN_TRANSCRIPT;
  // The default-on behavior must hold with NO opt-in env latch present.
  delete process.env.HZ_MARKDOWN_TRANSCRIPT;
});

afterAll(() => {
  if (savedLatch === undefined) delete process.env.HZ_MARKDOWN_TRANSCRIPT;
  else process.env.HZ_MARKDOWN_TRANSCRIPT = savedLatch;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "hz-e4-restore-"));
  dirs.push(d);
  return d;
};

const sourceMessages: ChatMsg[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "second answer", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
];

/** Write a standalone transcript the CLI/runtime can restore from. */
function writeSourceTranscript(sessionId: string): string {
  const file = path.join(scratch(), `${sessionId}.md`);
  writeFileSync(
    file,
    formatMarkdownTranscriptHeader({ sessionId, model: "mock" }) + formatMarkdownMessages(sourceMessages),
    { mode: 0o600 },
  );
  return file;
}

async function turnNotices(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  text: string,
): Promise<string[]> {
  const notices: string[] = [];
  await runtime.send(text, {
    onEvent: (event: RuntimeEvent) => {
      if (event.type === "notice") notices.push(event.message);
    },
  });
  return notices;
}

describe("E-4 --restore / runtime restore wire", () => {
  test("--restore [path] seeds the session store with the transcript messages", async () => {
    const workspace = scratch();
    const source = writeSourceTranscript("seed-session");
    const runtime = await createRuntime({ workspace, mock: true, restoreFromTranscript: source });
    try {
      const history = runtime.history();
      expect(history.map((m) => m.role)).toEqual(sourceMessages.map((m) => m.role));
      expect(history.map((m) => m.content)).toEqual(sourceMessages.map((m) => m.content));
      expect(history[3]!.toolCalls?.[0]?.name).toBe("read");
    } finally {
      await runtime.close();
    }
  });

  test("bare --restore (true) loads the default state transcript, alongside --continue", async () => {
    const workspace = scratch();
    const first = await createRuntime({ workspace, mock: true });
    const sessionId = first.sessionId;
    await first.close();
    const file = markdownTranscriptPath(workspace, sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      formatMarkdownTranscriptHeader({ sessionId }) + formatMarkdownMessages(sourceMessages),
      { mode: 0o600 },
    );

    const runtime = await createRuntime({
      workspace,
      mock: true,
      continueSession: true,
      restoreFromTranscript: true,
    });
    try {
      expect(runtime.sessionId).toBe(sessionId); // --continue still works
      expect(runtime.history().map((m) => m.content)).toEqual(sourceMessages.map((m) => m.content));
      expect(runtime.history()).not.toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  test("fail-closed on a missing transcript: no seed, clear notice", async () => {
    const workspace = scratch();
    const missing = path.join(workspace, "does-not-exist.md");
    const runtime = await createRuntime({ workspace, mock: true, restoreFromTranscript: missing });
    try {
      expect(runtime.history()).toHaveLength(0);
      const notices = await turnNotices(runtime, "hello");
      expect(notices.some((n) => n.includes("could not restore Markdown transcript"))).toBe(true);
      expect(notices.some((n) => n.includes("file not found"))).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  test("fail-closed on an unreadable transcript: no seed, clear notice", async () => {
    const workspace = scratch();
    // A directory at the path makes readFileSync throw (EISDIR), exercising the
    // helper's catch path rather than its "missing file" path.
    const corrupt = path.join(workspace, "corrupt-dir.md");
    mkdirSync(corrupt, { recursive: true });
    const runtime = await createRuntime({ workspace, mock: true, restoreFromTranscript: corrupt });
    try {
      expect(runtime.history()).toHaveLength(0);
      const notices = await turnNotices(runtime, "hello");
      expect(notices.some((n) => n.includes("could not restore Markdown transcript"))).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  test("continuous write is default-on: 0600 file in 0700 dir, no env latch", async () => {
    const workspace = scratch();
    expect(process.env.HZ_MARKDOWN_TRANSCRIPT).toBeUndefined();
    const runtime = await createRuntime({ workspace, mock: true });
    const sessionId = runtime.sessionId;
    try {
      await runtime.send("default on please", { onEvent: () => undefined });
    } finally {
      await runtime.close();
    }
    const file = markdownTranscriptPath(workspace, sessionId);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("## user");
    expect(text).toContain("default on please");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  test("per-event transcript round-trips through parse + resume after two turns", async () => {
    const workspace = scratch();
    const runtime = await createRuntime({ workspace, mock: true });
    const sessionId = runtime.sessionId;
    try {
      await runtime.send("turn one", { onEvent: () => undefined });
      await runtime.send("turn two", { onEvent: () => undefined });
    } finally {
      await runtime.close();
    }
    const file = markdownTranscriptPath(workspace, sessionId);
    const text = readFileSync(file, "utf8");
    expect(text.match(/^# Chat transcript/gm)?.length).toBe(1);
    expect(text).toContain("## user\nturn one");
    expect(text).toContain("## user\nturn two");

    const parsed = parseMarkdownTranscript(text);
    expect(parsed.messages.some((m) => m.role === "user" && m.content.includes("turn one"))).toBe(true);
    expect(parsed.messages.some((m) => m.role === "user" && m.content.includes("turn two"))).toBe(true);

    const resumed = resumeMessagesFromMarkdownTranscript({ workspace, sessionId });
    expect(resumed.ok).toBe(true);
    expect(resumed.sectionCount).toBe(countMarkdownMessageSections(text));
    expect(resumed.messages.map((m) => m.role)).toEqual(parsed.messages.map((m) => m.role));
  });

  test("a new turn after --restore appends once — restored rows are not duplicated", async () => {
    const workspace = scratch();
    const source = writeSourceTranscript("append-after-restore");
    const runtime = await createRuntime({ workspace, mock: true, restoreFromTranscript: source });
    const sessionId = runtime.sessionId;
    try {
      expect(runtime.history()).toHaveLength(sourceMessages.length);
      await runtime.send("a brand new turn", { onEvent: () => undefined });
    } finally {
      await runtime.close();
    }
    const text = readFileSync(markdownTranscriptPath(workspace, sessionId), "utf8");
    expect(text.match(/^## user\nfirst question$/gm)?.length).toBe(1);
    expect(text.match(/^# Chat transcript/gm)?.length).toBe(1);
    expect(countMarkdownMessageSections(text)).toBeGreaterThan(sourceMessages.length);
    const resumed = resumeMessagesFromMarkdownTranscript({ workspace, sessionId });
    expect(resumed.ok).toBe(true);
    expect(resumed.messages[0]!.content).toBe("first question");
  });
});

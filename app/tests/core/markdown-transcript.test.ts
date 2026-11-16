import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMsg } from "../../src/contracts";
import {
  appendMarkdownTranscriptEvent,
  clearMarkdownTranscriptCursors,
  countMarkdownMessageSections,
  formatMarkdownMessage,
  formatMarkdownMessages,
  formatMarkdownTranscriptHeader,
  markdownTranscriptCursor,
  markdownTranscriptEnabled,
  markdownTranscriptPath,
  parseMarkdownTranscript,
  resumeMessagesFromMarkdownTranscript,
  seedMarkdownTranscriptCursor,
  syncMarkdownTranscript,
} from "../../src/core/markdown-transcript";

const dirs: string[] = [];
afterEach(() => {
  clearMarkdownTranscriptCursors();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-md-tx-"));
  dirs.push(d);
  return d;
};

const history: ChatMsg[] = [
  { role: "user", content: "hi sk-abcdefghijklmnop" },
  { role: "assistant", content: "hello", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
];

describe("markdown transcript (E-4 reduced)", () => {
  test("on by default; explicit 0 is the only opt-out", () => {
    expect(markdownTranscriptEnabled({})).toBe(true);
    expect(markdownTranscriptEnabled({ HZ_MARKDOWN_TRANSCRIPT: undefined })).toBe(true);
    expect(markdownTranscriptEnabled({ HZ_MARKDOWN_TRANSCRIPT: "1" })).toBe(true);
    expect(markdownTranscriptEnabled({ HZ_MARKDOWN_TRANSCRIPT: "true" })).toBe(true);
    expect(markdownTranscriptEnabled({ HZ_MARKDOWN_TRANSCRIPT: "0" })).toBe(false);
  });

  test("formats messages and masks secrets", () => {
    const block = formatMarkdownMessage(history[0]!);
    expect(block).toContain("## user");
    expect(block).toContain("sk-***");
    expect(block).not.toContain("sk-abcdefghijklmnop");
    expect(formatMarkdownMessage(history[1]!)).toContain("### tool call: read");
    expect(formatMarkdownTranscriptHeader({ sessionId: "s1", model: "m" })).toContain("session: `s1`");
  });

  test("counts ## role sections for restart cursor", () => {
    expect(countMarkdownMessageSections("## user\na\n\n## assistant\nb\n")).toBe(2);
    expect(countMarkdownMessageSections("# Chat transcript\n- session: x\n")).toBe(0);
  });

  test("no-op on explicit opt-out", () => {
    const ws = tmp();
    const r = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "s1",
      history,
      env: { HZ_MARKDOWN_TRANSCRIPT: "0" },
    });
    expect(r.attempted).toBe(false);
    expect(r.written).toBe(false);
    expect(existsSync(r.path)).toBe(false);
  });

  test("creates file then appends only new messages", () => {
    const ws = tmp();
    const env = { HZ_MARKDOWN_TRANSCRIPT: "1" };
    const first = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "sess-1",
      history,
      meta: { title: "T", model: "mock" },
      env,
    });
    expect(first.attempted).toBe(true);
    expect(first.written).toBe(true);
    expect(first.created).toBe(true);
    expect(first.appended).toBe(2);
    expect(first.path).toBe(markdownTranscriptPath(ws, "sess-1"));
    expect(existsSync(first.path)).toBe(true);
    const round1 = readFileSync(first.path, "utf8");
    expect(round1).toContain("# Chat transcript");
    expect(round1).toContain("## user");
    expect(round1).toContain("## assistant");
    expect(round1).toContain("sk-***");

    const more: ChatMsg[] = [
      ...history,
      { role: "user", content: "again" },
      { role: "assistant", content: "ok" },
    ];
    const second = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "sess-1",
      history: more,
      env,
    });
    expect(second.created).toBe(false);
    expect(second.written).toBe(true);
    expect(second.appended).toBe(2);
    const round2 = readFileSync(first.path, "utf8");
    expect(round2).toContain("## user\nagain");
    expect(round2).toContain("## assistant\nok");
    // Header once; four message sections total.
    expect(round2.match(/^# Chat transcript/gm)?.length).toBe(1);
    expect(countMarkdownMessageSections(round2)).toBe(4);

    const noop = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "sess-1",
      history: more,
      env,
    });
    expect(noop.written).toBe(false);
    expect(noop.appended).toBe(0);
  });

  test("restart seeds cursor from on-disk sections (no duplicate append)", () => {
    const ws = tmp();
    const env = { HZ_MARKDOWN_TRANSCRIPT: "1" };
    const pathFile = markdownTranscriptPath(ws, "s2");
    const seed =
      formatMarkdownTranscriptHeader({ sessionId: "s2" }) +
      formatMarkdownMessage(history[0]!) +
      formatMarkdownMessage(history[1]!);
    mkdirSync(path.dirname(pathFile), { recursive: true });
    writeFileSync(pathFile, seed, { mode: 0o600 });
    clearMarkdownTranscriptCursors();

    const r = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "s2",
      history,
      env,
    });
    expect(r.written).toBe(false);
    expect(r.appended).toBe(0);
    expect(countMarkdownMessageSections(readFileSync(pathFile, "utf8"))).toBe(2);

    const extended = [...history, { role: "user", content: "next" } as ChatMsg];
    const r2 = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "s2",
      history: extended,
      env,
    });
    expect(r2.appended).toBe(1);
    expect(readFileSync(pathFile, "utf8")).toContain("## user\nnext");
  });

  test("parseMarkdownTranscript round-trips roles, body, tool calls, meta", () => {
    const msgs: ChatMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi sk-abcdefghijklmnop" },
      {
        role: "assistant",
        content: "hello",
        toolCalls: [{ id: "1", name: "read", arguments: '{"p":1}' }],
      },
      { role: "tool", content: "file text", toolName: "read" },
    ];
    const text =
      formatMarkdownTranscriptHeader({
        sessionId: "sess-parse",
        title: "T",
        model: "mock",
        startedAt: "2026-11-15T00:00:00.000Z",
      }) + formatMarkdownMessages(msgs);
    const parsed = parseMarkdownTranscript(text);
    expect(parsed.meta.sessionId).toBe("sess-parse");
    expect(parsed.meta.title).toBe("T");
    expect(parsed.meta.model).toBe("mock");
    expect(parsed.meta.startedAt).toBe("2026-11-15T00:00:00.000Z");
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(parsed.messages[1]!.role).toBe("user");
    expect(parsed.messages[1]!.content).toContain("sk-***");
    expect(parsed.messages[1]!.content).not.toContain("sk-abcdefghijklmnop");
    expect(parsed.messages[2]!.role).toBe("assistant");
    expect(parsed.messages[2]!.content).toBe("hello");
    expect(parsed.messages[2]!.toolCalls).toEqual([
      { id: "md_tc_1", name: "read", arguments: "{}" },
    ]);
    expect(parsed.messages[3]).toEqual({
      role: "tool",
      content: "file text",
      toolName: "read",
    });
  });

  test("resumeMessagesFromMarkdownTranscript loads file and seeds cursor", () => {
    const ws = tmp();
    const env = { HZ_MARKDOWN_TRANSCRIPT: "1" };
    const created = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "resume-1",
      history,
      meta: { title: "R", model: "m" },
      env,
    });
    expect(created.created).toBe(true);
    clearMarkdownTranscriptCursors();

    const resumed = resumeMessagesFromMarkdownTranscript({
      workspace: ws,
      sessionId: "resume-1",
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.missing).toBeUndefined();
    expect(resumed.path).toBe(created.path);
    expect(resumed.sectionCount).toBe(2);
    expect(resumed.meta.sessionId).toBe("resume-1");
    expect(resumed.messages[0]!.role).toBe("user");
    expect(resumed.messages[1]!.toolCalls?.[0]?.name).toBe("read");

    // Seeded cursor: sync with same history must not duplicate.
    const again = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "resume-1",
      history,
      env,
    });
    expect(again.written).toBe(false);
    expect(again.appended).toBe(0);
    expect(countMarkdownMessageSections(readFileSync(created.path, "utf8"))).toBe(2);

    const more = [...history, { role: "user", content: "after-resume" } as ChatMsg];
    const append = syncMarkdownTranscript({
      workspace: ws,
      sessionId: "resume-1",
      history: more,
      env,
    });
    expect(append.appended).toBe(1);
    expect(readFileSync(created.path, "utf8")).toContain("## user\nafter-resume");
  });

  test("resumeMessagesFromMarkdownTranscript missing file is fail-closed", () => {
    const ws = tmp();
    const r = resumeMessagesFromMarkdownTranscript({
      workspace: ws,
      sessionId: "nope",
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
    expect(r.messages).toEqual([]);
    expect(r.error).toContain("not found");
  });

  test("append-one-event writes 0600/0700 by default (no env latch)", () => {
    const ws = tmp();
    const r = appendMarkdownTranscriptEvent({
      workspace: ws,
      sessionId: "evt-1",
      message: history[0]!,
      env: {}, // no HZ_MARKDOWN_TRANSCRIPT — default-on
    });
    expect(r.attempted).toBe(true);
    expect(r.written).toBe(true);
    expect(r.created).toBe(true);
    expect(r.appended).toBe(1);
    expect(existsSync(r.path)).toBe(true);
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain("# Chat transcript");
    expect(countMarkdownMessageSections(text)).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(r.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(r.path)).mode & 0o777).toBe(0o700);
    }
    // Explicit opt-out makes the one-event append a no-op too.
    const off = appendMarkdownTranscriptEvent({
      workspace: ws,
      sessionId: "evt-1",
      message: history[1]!,
      env: { HZ_MARKDOWN_TRANSCRIPT: "0" },
    });
    expect(off.attempted).toBe(false);
    expect(off.written).toBe(false);
    expect(countMarkdownMessageSections(readFileSync(r.path, "utf8"))).toBe(1);
  });

  test("per-event append round-trips through parse + resume and shares the sync cursor", () => {
    const ws = tmp();
    const msgs: ChatMsg[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
      { role: "tool", content: "file body", toolName: "read" },
    ];
    for (const msg of msgs) {
      const at = markdownTranscriptCursor(ws, "evt-roundtrip", msgs.length);
      const r = appendMarkdownTranscriptEvent({
        workspace: ws,
        sessionId: "evt-roundtrip",
        message: msgs[at]!,
        meta: { model: "mock" },
        env: {},
      });
      expect(r.written).toBe(true);
      expect(r.appended).toBe(1);
    }
    const file = markdownTranscriptPath(ws, "evt-roundtrip");
    const text = readFileSync(file, "utf8");
    expect(text.match(/^# Chat transcript/gm)?.length).toBe(1);
    expect(countMarkdownMessageSections(text)).toBe(3);

    const parsed = parseMarkdownTranscript(text);
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(parsed.messages[0]!.content).toBe("first");
    expect(parsed.messages[1]!.toolCalls?.[0]?.name).toBe("read");
    expect(parsed.messages[2]!.toolName).toBe("read");

    const resumed = resumeMessagesFromMarkdownTranscript({ workspace: ws, sessionId: "evt-roundtrip" });
    expect(resumed.ok).toBe(true);
    expect(resumed.messages).toHaveLength(3);

    // The per-turn full-history mirror sees the same cursor: no duplicate write.
    const sync = syncMarkdownTranscript({ workspace: ws, sessionId: "evt-roundtrip", history: msgs, env: {} });
    expect(sync.written).toBe(false);
    expect(sync.appended).toBe(0);
    expect(countMarkdownMessageSections(readFileSync(file, "utf8"))).toBe(3);
  });

  test("append-one-event fails closed if the cursor is ahead of a missing file", () => {
    const ws = tmp();
    seedMarkdownTranscriptCursor(ws, "evt-ahead", 5);
    const r = appendMarkdownTranscriptEvent({
      workspace: ws,
      sessionId: "evt-ahead",
      message: { role: "user", content: "x" },
      env: {},
    });
    expect(r.written).toBe(false);
    expect(r.error).toContain("inconsistent cursor");
    expect(existsSync(r.path)).toBe(false);
  });
});

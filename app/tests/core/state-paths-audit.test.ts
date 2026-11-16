/**
 * state-paths-audit.test.ts — runtime stores live under `<workspace>/.hz/state`
 * (docs/12 §4.1), open owner-only (dirs 0700, files 0600), and `.hz/` carries a
 * self-ignore. The pre-audit `.hz/<name>` files stay readable by a one-time
 * copy into the state tree; the legacy bytes are not moved.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defaultHzsExportPath, writeSessionArchive } from "../../src/core/archive";
import { createHandoff, handoffDbPath, resumeHandoff } from "../../src/core/memory/handoff";
import { memoryDbPath, memorySearch, replaceMemoryIndex } from "../../src/core/memory/store";
import {
  markdownTranscriptPath,
  resumeMessagesFromMarkdownTranscript,
  syncMarkdownTranscript,
} from "../../src/core/markdown-transcript";
import { ensureHarnessGitignore, stateRoot, workspaceStateDir } from "../../src/core/paths";
import { searchSessions, sessionSearchDbPath, upsertSessionSearch } from "../../src/core/session-search";
import { SessionStore } from "../../src/core/session";

const onUnix = process.platform !== "win32";
const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-state-audit-"));
  workspaces.push(dir);
  return dir;
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe("canonical runtime state paths", () => {
  test("every store resolves under .hz/state, including exports and transcripts", () => {
    const workspace = scratch();
    const state = path.join(workspace, ".hz", "state");
    expect(workspaceStateDir(workspace)).toBe(state);
    expect(sessionSearchDbPath(workspace)).toBe(path.join(state, "session_search.db"));
    expect(memoryDbPath(workspace)).toBe(path.join(state, "memory.db"));
    expect(handoffDbPath(workspace)).toBe(path.join(state, "handoffs.db"));
    expect(defaultHzsExportPath(workspace, "sess_1")).toBe(path.join(state, "exports", "sess_1.hzs"));
    expect(markdownTranscriptPath(workspace, "sess_1")).toBe(
      path.join(state, "transcripts", "sess_1.md"),
    );
  });

  test("opened stores create 0700 parents and 0600 files; .hz/.gitignore is `*`", () => {
    const workspace = scratch();
    const state = workspaceStateDir(workspace);

    upsertSessionSearch(workspace, {
      sessionId: "s1",
      title: "t",
      updated: "2026-01-01T00:00:00.000Z",
      content: "alpha beta",
    });
    expect(searchSessions(workspace, "alpha").length).toBe(1);

    createHandoff(workspace, { summary: "state path check" }, { continues_from: null });
    replaceMemoryIndex(workspace, ["state path fact"]);

    const store = new SessionStore(workspace);
    const session = store.createSession("export");
    store.appendMessage(session.id, { role: "user", content: "hello" });
    store.close();
    const archive = writeSessionArchive(workspace, session.id);

    const transcript = syncMarkdownTranscript({
      workspace,
      sessionId: "transcript-check",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
      ],
      env: { HZ_MARKDOWN_TRANSCRIPT: "1" },
    });

    expect(existsSync(sessionSearchDbPath(workspace))).toBe(true);
    expect(existsSync(handoffDbPath(workspace))).toBe(true);
    expect(existsSync(memoryDbPath(workspace))).toBe(true);
    expect(existsSync(archive.path)).toBe(true);
    expect(existsSync(transcript.path)).toBe(true);
    expect(transcript.written).toBe(true);

    const gitignore = ensureHarnessGitignore(workspace);
    expect(gitignore).toBe(path.join(workspace, ".hz", ".gitignore"));
    expect(readFileSync(gitignore, "utf8")).toBe("*\n");
    // Idempotent: a second call leaves the same bytes.
    ensureHarnessGitignore(workspace);
    expect(readFileSync(gitignore, "utf8")).toBe("*\n");

    if (onUnix) {
      expect(modeOf(state)).toBe(0o700);
      expect(modeOf(sessionSearchDbPath(workspace))).toBe(0o600);
      expect(modeOf(handoffDbPath(workspace))).toBe(0o600);
      expect(modeOf(memoryDbPath(workspace))).toBe(0o600);
      expect(modeOf(path.dirname(archive.path))).toBe(0o700);
      expect(modeOf(archive.path)).toBe(0o600);
      expect(modeOf(path.dirname(transcript.path))).toBe(0o700);
      expect(modeOf(transcript.path)).toBe(0o600);
      expect(modeOf(gitignore)).toBe(0o600);
    }
  });
});

describe("legacy state stays readable", () => {
  test("a legacy .hz/memory.db is copied into .hz/state and searched", () => {
    const workspace = scratch();
    const legacy = path.join(stateRoot(workspace), "memory.db");
    mkdirSync(path.dirname(legacy), { recursive: true });
    const db = new Database(legacy, { create: true });
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content, bank UNINDEXED, tokenize='porter');`);
    db.prepare(`INSERT INTO memory_fts(content, bank) VALUES (?, ?)`).run(
      "legacy fact about landlock",
      "project",
    );
    db.close();

    const hits = memorySearch(workspace, "landlock");
    expect(hits.some((hit) => hit.includes("landlock"))).toBe(true);
    expect(existsSync(legacy)).toBe(true); // legacy bytes left for inspection
    expect(existsSync(memoryDbPath(workspace))).toBe(true); // state copy created
  });

  test("a legacy .hz/handoffs.db is read after the state file is absent", () => {
    const workspace = scratch();
    const created = createHandoff(workspace, { summary: "legacy handoff row" }, { continues_from: null });
    const current = handoffDbPath(workspace);
    const legacy = path.join(stateRoot(workspace), "handoffs.db");
    renameSync(current, legacy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${current}${suffix}`)) renameSync(`${current}${suffix}`, `${legacy}${suffix}`);
    }

    const resumed = resumeHandoff(workspace);
    expect(resumed.latest_handoff_id).toBe(created.id);
    expect(resumed.top_sections.some((section) => section.section_text.includes("legacy handoff"))).toBe(true);
    expect(existsSync(current)).toBe(true);
  });

  test("a legacy .hz/transcripts file is loaded by resume", () => {
    const workspace = scratch();
    const sessionId = "legacy-session";
    const legacy = path.join(stateRoot(workspace), "transcripts", `${sessionId}.md`);
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, `# Chat transcript\n\n- session: \`${sessionId}\`\n\n## user\nhello legacy\n`);

    const resumed = resumeMessagesFromMarkdownTranscript({ workspace, sessionId });
    expect(resumed.ok).toBe(true);
    expect(resumed.path).toBe(legacy);
    expect(resumed.messages.some((message) => message.content.includes("hello legacy"))).toBe(true);
    expect(existsSync(markdownTranscriptPath(workspace, sessionId))).toBe(false);
  });
});

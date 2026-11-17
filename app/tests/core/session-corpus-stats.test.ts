import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordPostmortem, type PostmortemRecord } from "../../src/core/postmortem";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";
import { runSessionStatsCli } from "../../src/session-stats";
import { SessionStore } from "../../src/core/session";
import { formatMarkdownMessages, formatMarkdownTranscriptHeader } from "../../src/core/markdown-transcript";
import { sessionDbPath, workspaceStateDir } from "../../src/core/paths";
import {
  buildWorkspaceCorpusReport,
  histogramFromPostmortems,
  readMarkdownTranscriptCorpus,
  readSessionDbCorpus,
  renderCorpusTuningReport,
  renderFullCorpusSummary,
  renderFullCorpusTuningReport,
  renderSessionCorpusSummary,
  suggestCorpusTuning,
  toolCountsFromMessages,
  TUNING_DOMINANT_TOOL_RATE,
  TUNING_FAILURE_RATE,
  TUNING_MIN_RECORDS,
  TUNING_MIN_TOOL_CALLS,
} from "../../src/core/session-corpus-stats";

describe("J-5 session corpus stats", () => {
  test("histogram merges tool counts", () => {
    const pm = {
      terminal: "failed",
      toolCalls: { read: 3, shell: 1 },
    } as PostmortemRecord;
    const summary = histogramFromPostmortems([pm]);
    expect(summary.tools[0]?.tool).toBe("read");
    const text = renderSessionCorpusSummary(summary);
    expect(text).toContain("read: 3");
  });

  test("ruling 510: every published corpus statistic is a contracted block", () => {
    const records = [
      pm({ id: "a", terminal: "failed", failureClass: "tool_error", toolCalls: { read: 3 } }),
      pm({ id: "b", terminal: "succeeded", toolCalls: { grep: 2 } }),
    ];
    const summary = histogramFromPostmortems(records);
    const report = suggestCorpusTuning(records);
    expect(summary.published.length).toBeGreaterThan(0);
    expect(report.published.length).toBeGreaterThan(summary.published.length);
    for (const block of [...summary.published, ...report.published]) {
      assertPublishedNumber(block);
    }
    // Honest fields: the corpus population IS known from the loaded records;
    // it is a real value, not a fabricated or "unknown" one.
    const parsed = parsePublishedNumber(summary.published[0]!);
    expect(parsed.metric).toBe("post-mortem records in corpus");
    expect(parsed.population).toContain("2 post-mortem record(s)");
    expect(parsed.value).toBe("2");
  });
});

function pm(partial: Partial<PostmortemRecord>): PostmortemRecord {
  return {
    id: "x",
    sessionId: "s",
    ts: "2026-01-01T00:00:00Z",
    terminal: "succeeded",
    detail: null,
    failureClass: "unknown",
    task: null,
    transcript: { firstSeq: null, lastSeq: null, count: 1, textDigest: "d" },
    toolCalls: {},
    failureDigest: "f",
    ...partial,
  } as PostmortemRecord;
}

describe("transcript optimiser suggestions (J-5)", () => {
  test("thresholds are documented constants", () => {
    expect(TUNING_MIN_RECORDS).toBe(3);
    expect(TUNING_FAILURE_RATE).toBe(0.5);
    expect(TUNING_DOMINANT_TOOL_RATE).toBe(0.6);
    expect(TUNING_MIN_TOOL_CALLS).toBe(10);
  });

  test("dominant tool produces a concrete, counted suggestion", () => {
    const records = [
      ...[0, 1, 2, 3].map((i) => pm({ id: `r${i}`, toolCalls: { read: 3 } })),
      pm({ id: "r4", toolCalls: { grep: 3 } }),
    ];
    const report = suggestCorpusTuning(records);
    const dominant = report.suggestions.find((s) => s.id === "dominant-tool");
    expect(dominant).toBeDefined();
    expect(dominant?.area).toBe("tool");
    expect(dominant?.detail).toContain("read is 12/15 tool calls (80%");
    expect(dominant?.detail).toContain("Batch or scope");
    expect(report.summary.tools[0]?.tool).toBe("read");
  });

  test("high failure rate + tool_error class produce prompt/tool tuning", () => {
    const records = [
      pm({ id: "a", terminal: "failed", failureClass: "tool_error" }),
      pm({ id: "b", terminal: "failed", failureClass: "tool_error" }),
      pm({ id: "c", terminal: "failed", failureClass: "tool_error" }),
      pm({ id: "d", terminal: "succeeded", failureClass: "unknown" }),
    ];
    const report = suggestCorpusTuning(records);
    const ids = report.suggestions.map((s) => s.id);
    expect(ids).toContain("high-failure-rate");
    expect(ids).toContain("tool-error-class");
    const high = report.suggestions.find((s) => s.id === "high-failure-rate");
    expect(high?.detail).toContain("3/4 post-mortems ended 'failed'");
    expect(high?.detail).toContain("tool_error");
    expect(ids.indexOf("high-failure-rate")).toBeLessThan(ids.indexOf("tool-error-class"));
  });

  test("missing telemetry and unknown terminals are surfaced", () => {
    const report = suggestCorpusTuning([
      pm({ id: "a", terminal: "unknown" }),
      pm({ id: "b", terminal: "unknown" }),
    ]);
    const ids = report.suggestions.map((s) => s.id);
    expect(ids).toContain("tool-telemetry");
    expect(ids).toContain("unknown-terminal");
    expect(report.suggestions.find((s) => s.id === "unknown-terminal")?.detail).toContain("2 post-mortem(s)");
  });

  test("suggestions are deterministic and rendered with counts", () => {
    const records = [
      pm({ id: "a", terminal: "failed", failureClass: "budget", toolCalls: { shell: 6 } }),
      pm({ id: "b", terminal: "failed", failureClass: "budget", toolCalls: { shell: 2 } }),
      pm({ id: "c", terminal: "succeeded", failureClass: "unknown", toolCalls: { read: 1 } }),
    ];
    const first = suggestCorpusTuning(records);
    expect(suggestCorpusTuning(records)).toEqual(first);
    const priorities = first.suggestions.map((s) => s.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
    const text = renderCorpusTuningReport(first);
    expect(text).toContain(`tuning suggestions (${first.suggestions.length})`);
    expect(text).toContain("shell-heavy");
    expect(text).toContain("budget failures");
    expect(text).toContain("session corpus: 3 post-mortem(s)");
  });

  test("a tuned corpus yields no suggestions", () => {
    const report = suggestCorpusTuning([
      pm({ id: "a", toolCalls: { read: 1 } }),
      pm({ id: "b", toolCalls: { grep: 1 } }),
    ]);
    expect(report.suggestions).toEqual([]);
    expect(renderCorpusTuningReport(report)).toContain("(none — corpus looks tuned)");
  });
});

describe("session-stats CLI flags (J-5)", () => {
  async function corpus(): Promise<string> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "session-stats-cli-"));
    for (let i = 0; i < 5; i += 1) {
      await recordPostmortem({
        stateDir: dir,
        sessionId: `s${i}`,
        terminal: i < 4 ? "failed" : "succeeded",
        failureClass: "tool_error",
        transcript: "task text",
        toolCalls: { read: 3 },
        now: 1_700_000_000_000 + i,
      });
    }
    return dir;
  }

  async function capture(argv: readonly string[]): Promise<{ code: number; out: string }> {
    const original = console.log;
    let out = "";
    console.log = (text?: unknown) => {
      out += `${String(text)}\n`;
    };
    try {
      const code = await runSessionStatsCli(argv);
      return { code, out };
    } finally {
      console.log = original;
    }
  }

  test("default output is the summary only (backward compatible)", async () => {
    const dir = await corpus();
    const { code, out } = await capture(["--postmortems", dir]);
    expect(code).toBe(0);
    expect(out).toContain("session corpus: 5 post-mortem(s)");
    expect(out).not.toContain("tuning suggestions");
  });

  test("--suggest / --tune emit the optimiser report over the real corpus", async () => {
    const dir = await corpus();
    for (const flag of ["--suggest", "--tune"]) {
      const { code, out } = await capture(["--postmortems", dir, flag]);
      expect(code).toBe(0);
      expect(out).toContain("tuning suggestions (");
      expect(out).toContain("dominant tool: read");
      expect(out).toContain("tool_error");
    }
  });

  test("--json emits machine-readable summary + suggestions", async () => {
    const dir = await corpus();
    const { code, out } = await capture(["--postmortems", dir, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim()) as {
      summary: { records: number };
      suggestions: Array<{ id: string }>;
    };
    expect(parsed.summary.records).toBe(5);
    expect(parsed.suggestions.map((s) => s.id)).toContain("dominant-tool");
  });

  test("missing --postmortems returns usage exit code 2", async () => {
    const { code } = await capture([]);
    expect(code).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Full-corpus optimiser over the real session DB + Markdown transcripts      */
/* -------------------------------------------------------------------------- */

function toolMessage(name: string) {
  return { role: "tool" as const, content: "ok", toolCallId: `c-${name}`, toolName: name };
}

function seedWorkspace(opts: { sessions: number; readsPerSession: number; transcriptTools?: string[] }): {
  ws: string;
  state: string;
} {
  const ws = mkdtempSync(path.join(os.tmpdir(), "j5-full-"));
  const store = new SessionStore(ws);
  for (let i = 0; i < opts.sessions; i += 1) {
    const s = store.createSession(`s${i}`);
    for (let r = 0; r < opts.readsPerSession; r += 1) store.appendMessage(s.id, toolMessage("read"));
    if (i % 2 === 0) store.appendMessage(s.id, toolMessage("grep"));
  }
  store.close();
  const state = workspaceStateDir(ws);
  const tdir = path.join(state, "transcripts");
  mkdirSync(tdir, { recursive: true });
  const tools = opts.transcriptTools ?? [];
  if (tools.length > 0) {
    const messages = tools.map((name) => toolMessage(name));
    writeFileSync(
      path.join(tdir, "session.md"),
      formatMarkdownTranscriptHeader({ sessionId: "s" }) + formatMarkdownMessages(messages),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return { ws, state };
}

describe("full-corpus optimiser (J-5, rows over the session DB + transcripts)", () => {
  test("empty workspace is a healthy zero result (no DB, no transcripts)", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "j5-empty-"));
    try {
      const report = await buildWorkspaceCorpusReport(ws);
      expect(report.summary.records).toBe(0);
      expect(report.summary.tools).toEqual([]);
      expect(report.sources.sessionDb.sessions).toBe(0);
      expect(report.sources.transcripts.transcripts).toBe(0);
      expect(report.counts.toolCalls).toBe(0);
      for (const block of report.published) assertPublishedNumber(block);
      expect(renderFullCorpusSummary(report)).toContain("corpus sources: postmortems=0");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("reads tool counts from one real session DB (read-only)", () => {
    const { ws } = seedWorkspace({ sessions: 1, readsPerSession: 2 });
    try {
      const corpus = readSessionDbCorpus(ws);
      expect(corpus.sessions).toBe(1);
      expect(corpus.messages).toBe(3); // 2 read + 1 grep (i=0)
      expect(corpus.toolCalls.read).toBe(2);
      expect(corpus.toolCalls.grep).toBe(1);
      // Reading did not create/modify the DB: no error, no quarantine.
      expect(corpus.error).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("reads Markdown transcripts and merges them with the DB into one corpus", async () => {
    const { ws, state } = seedWorkspace({
      sessions: 2,
      readsPerSession: 2,
      transcriptTools: ["shell", "shell", "shell", "shell", "shell", "read"],
    });
    try {
      const transcripts = readMarkdownTranscriptCorpus(ws);
      expect(transcripts.transcripts).toBe(1);
      expect(transcripts.toolCalls.shell).toBe(5);
      const report = await buildWorkspaceCorpusReport(ws, state);
      // DB: 2 sessions × 2 read = 4 read, plus grep on i=0 = 1 grep.
      // Transcript: 5 shell + 1 read. Merged: read=5, shell=5, grep=1.
      expect(report.summary.tools.find((t) => t.tool === "read")?.count).toBe(5);
      expect(report.summary.tools.find((t) => t.tool === "shell")?.count).toBe(5);
      expect(report.counts.toolCalls).toBe(11);
      const shellHeavy = report.suggestions.find((s) => s.id === "shell-heavy");
      expect(shellHeavy).toBeDefined();
      expect(shellHeavy?.detail).toContain("shell has 5 calls");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("malformed DB rows are skipped, never mistaken for tool calls or crashing", async () => {
    const { ws, state } = seedWorkspace({ sessions: 1, readsPerSession: 1 });
    try {
      const db = new Database(sessionDbPath(ws));
      const sid = db.query("SELECT id FROM sessions LIMIT 1").get() as { id: string };
      db.run("INSERT INTO messages (id, session_id, role, content, ts, meta) VALUES (?, ?, ?, ?, ?, ?)", [
        "bad-meta",
        sid.id,
        "tool",
        "x",
        "",
        "{not json",
      ]);
      db.run("INSERT INTO messages (id, session_id, role, content, ts, meta) VALUES (?, ?, ?, ?, ?, ?)", [
        "bad-role",
        sid.id,
        null,
        "x",
        "",
        null,
      ]);
      db.close();
      const corpus = readSessionDbCorpus(ws);
      expect(corpus.skipped).toBeGreaterThanOrEqual(2);
      expect(corpus.toolCalls.read).toBe(1);
      const report = await buildWorkspaceCorpusReport(ws, state);
      expect(report.counts.skipped).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("output is deterministic across runs over the same corpus", async () => {
    const { ws, state } = seedWorkspace({ sessions: 3, readsPerSession: 4, transcriptTools: ["shell", "shell", "shell"] });
    try {
      const first = await buildWorkspaceCorpusReport(ws, state);
      const second = await buildWorkspaceCorpusReport(ws, state);
      expect(second.summary).toEqual(first.summary);
      expect(second.suggestions).toEqual(first.suggestions);
      expect(renderFullCorpusTuningReport(second)).toBe(renderFullCorpusTuningReport(first));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("post-mortems still contribute terminal/failure suggestions in full mode", async () => {
    const { ws, state } = seedWorkspace({ sessions: 0, readsPerSession: 0 });
    try {
      for (let i = 0; i < 3; i += 1) {
        await recordPostmortem({
          stateDir: state,
          sessionId: `p${i}`,
          terminal: "failed",
          failureClass: "tool_error",
          transcript: "task",
          toolCalls: { read: 1 },
          now: 1_700_000_000_000 + i,
        });
      }
      const report = await buildWorkspaceCorpusReport(ws, state);
      expect(report.sources.postmortems).toBe(3);
      const ids = report.suggestions.map((s) => s.id);
      expect(ids).toContain("high-failure-rate");
      expect(ids).toContain("tool-error-class");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("--workspace drives --suggest/--tune/--json over the fuller corpus", async () => {
    const { ws } = seedWorkspace({ sessions: 2, readsPerSession: 6 });
    try {
      const original = console.log;
      let out = "";
      console.log = (text?: unknown) => {
        out += `${String(text)}\n`;
      };
      try {
        expect(await runSessionStatsCli(["--workspace", ws, "--suggest"])).toBe(0);
        expect(out).toContain("dominant tool: read");
        expect(out).toContain("corpus sources:");
        out = "";
        expect(await runSessionStatsCli(["--workspace", ws, "--tune", "--json"])).toBe(0);
        const parsed = JSON.parse(out.trim()) as {
          sources: { sessionDb: { sessions: number }; transcripts: { transcripts: number } };
          suggestions: Array<{ id: string }>;
        };
        expect(parsed.sources.sessionDb.sessions).toBe(2);
        expect(parsed.suggestions.map((s) => s.id)).toContain("dominant-tool");
      } finally {
        console.log = original;
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("toolCountsFromMessages counts tool-result messages only", () => {
    const msgs = [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { role: "tool" as const, content: "ok", toolName: "read" },
      { role: "tool" as const, content: "ok", toolName: "shell" },
      { role: "tool" as const, content: "ok" }, // no toolName — skipped
    ];
    expect(toolCountsFromMessages(msgs as never)).toEqual({ read: 1, shell: 1 });
  });
});

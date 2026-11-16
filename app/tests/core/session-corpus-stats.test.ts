import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordPostmortem, type PostmortemRecord } from "../../src/core/postmortem";
import { runSessionStatsCli } from "../../src/session-stats";
import {
  histogramFromPostmortems,
  renderCorpusTuningReport,
  renderSessionCorpusSummary,
  suggestCorpusTuning,
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

/**
 * J-5: analyse the session/post-mortem corpus for tool usage histograms and
 * emit concrete tool/prompt tuning suggestions (omp session-stats idea).
 * Pure and read-only: suggestions are derived from already-loaded records and
 * bounded, read-only scans of the session SQLite DB and Markdown transcripts.
 * No session/DB/transcript file is mutated and no network is used.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { ChatMsg } from "../contracts";
import { parseMarkdownTranscript } from "./markdown-transcript";
import { metricContract } from "./metrics";
import { sessionDbPath, workspaceStateDir } from "./paths";
import { loadPostmortems, type PostmortemRecord } from "./postmortem";
import { rowToChatMsg } from "./session";

/**
 * H-7 / ruling 510 — metric contract (docs/16 §2.4.3) for this module's
 * published numbers. Every numeric statistic is rendered by `metricContract`
 * into a `published` block; the raw counts stay beside it only for branching
 * and for the byte-identical human renderer (the same split evals.ts uses).
 *
 * There is no prior corpus snapshot in this repo, so the anchor is honestly
 * "none — first measurement". The corpus population *is* known (the loaded
 * record count), but where those sessions came from is not, so that part of
 * the population is stated as "unknown" rather than fabricated.
 */
const CORPUS_ANCHOR = "none — first measurement (no prior corpus snapshot to compare against)";
function corpusPopulation(recordCount: number): string {
  return `${recordCount} post-mortem record(s) in this loaded corpus (session-corpus-stats.ts); session provenance unknown`;
}
const TERMINAL_EXCLUDES = "none — every loaded record contributes one terminal (a missing terminal is counted as 'unknown')";
const TOOL_EXCLUDES =
  "tool-call entries with a non-numeric or <1 count, and records that carry no toolCalls, contribute no tool counts";
const SUGGESTION_EXCLUDES =
  "none — every derived suggestion is published; thresholds are exported constants, not measured results";
/** Row cap in the human summary; shared so the "+N more" count can be contracted below. */
const SUMMARY_TOOL_ROW_CAP = 24;

export interface ToolCallHistogram {
  tool: string;
  count: number;
}

export interface SessionCorpusSummary {
  records: number;
  terminals: Record<string, number>;
  tools: ToolCallHistogram[];
  /** One contracted block per published numeric statistic (H-7, ruling 510) — never a bare number. */
  published: string[];
}

export function histogramFromPostmortems(records: readonly PostmortemRecord[]): SessionCorpusSummary {
  const terminals: Record<string, number> = {};
  const toolCounts = new Map<string, number>();
  for (const pm of records) {
    const term = pm.terminal ?? "unknown";
    terminals[term] = (terminals[term] ?? 0) + 1;
    const tools = pm.toolCalls ?? {};
    for (const [name, count] of Object.entries(tools)) {
      if (typeof count !== "number" || count < 1) continue;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
    }
  }
  const tools = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  // H-7/ruling 510: contract every numeric statistic this summary publishes.
  // The human renderer below reads the raw counts (so its text stays
  // byte-identical); these blocks are the machine-readable publication surface.
  const population = corpusPopulation(records.length);
  const published = [
    metricContract({
      metric: "post-mortem records in corpus",
      anchor: CORPUS_ANCHOR,
      population,
      excludes: "none — every loaded record is counted",
      value: records.length,
    }),
  ];
  for (const [term, count] of Object.entries(terminals)) {
    published.push(
      metricContract({
        metric: `post-mortems with terminal ${term}`,
        anchor: CORPUS_ANCHOR,
        population,
        excludes: TERMINAL_EXCLUDES,
        value: count,
      }),
    );
  }
  for (const row of tools) {
    published.push(
      metricContract({
        metric: `tool calls: ${row.tool}`,
        anchor: CORPUS_ANCHOR,
        population,
        excludes: TOOL_EXCLUDES,
        value: row.count,
      }),
    );
  }
  published.push(
    metricContract({
      metric: "distinct tools with recorded calls",
      anchor: CORPUS_ANCHOR,
      population,
      excludes: TOOL_EXCLUDES,
      value: tools.length,
    }),
    metricContract({
      metric: "tool rows omitted from the human summary display",
      anchor: CORPUS_ANCHOR,
      population,
      excludes: TOOL_EXCLUDES,
      value: Math.max(0, tools.length - SUMMARY_TOOL_ROW_CAP),
    }),
  );

  return { records: records.length, terminals, tools, published };
}

export function renderSessionCorpusSummary(summary: SessionCorpusSummary): string {
  const lines = [`session corpus: ${summary.records} post-mortem(s)`];
  const termParts = Object.entries(summary.terminals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  if (termParts.length > 0) lines.push(`terminals: ${termParts.join(", ")}`);
  if (summary.tools.length > 0) {
    lines.push("tools:");
    for (const row of summary.tools.slice(0, SUMMARY_TOOL_ROW_CAP)) {
      lines.push(`  ${row.tool}: ${row.count}`);
    }
    if (summary.tools.length > SUMMARY_TOOL_ROW_CAP) {
      lines.push(`  … +${summary.tools.length - SUMMARY_TOOL_ROW_CAP} more`);
    }
  } else {
    lines.push("tools: (none recorded)");
  }
  return lines.join("\n");
}

/* ---------------------- transcript optimiser suggestions (J-5) ---------------------- */

/** Thresholds are exported so tests and callers can state the rule, not guess it. */
export const TUNING_MIN_RECORDS = 3;
export const TUNING_FAILURE_RATE = 0.5;
export const TUNING_DOMINANT_TOOL_RATE = 0.6;
export const TUNING_MIN_TOOL_CALLS = 10;
export const TUNING_MIN_SHELL_CALLS = 5;

export type TuningArea = "tool" | "prompt" | "telemetry";

export interface TuningSuggestion {
  /** Stable id (sorted by priority then id for deterministic output). */
  id: string;
  area: TuningArea;
  severity: "info" | "warn";
  /** Short label. */
  title: string;
  /** Concrete, actionable instruction naming the observed counts. */
  detail: string;
  /** Lower sorts first. */
  priority: number;
}

export interface CorpusTuningReport {
  summary: SessionCorpusSummary;
  suggestions: TuningSuggestion[];
  /** One contracted block per published numeric statistic (H-7, ruling 510) — never a bare number. */
  published: string[];
}

function failureClassCounts(records: readonly PostmortemRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const pm of records) {
    const name = typeof pm.failureClass === "string" ? pm.failureClass : "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The numeric/derived signals the suggestion rules judge. */
interface SuggestionSignals {
  summary: SessionCorpusSummary;
  failed: number;
  unknown: number;
  /** Number of records carrying an outcome (post-mortems); the failure-rate denominator. */
  outcomeCount: number;
  failureClasses: Array<[string, number]>;
  /** H-7 population description for the publication surface. */
  population: string;
}

/** The suggestion rules, shared by the post-mortem-only and full-corpus views. */
function deriveSuggestions(signals: SuggestionSignals): TuningSuggestion[] {
  const { summary, failed, unknown, outcomeCount, failureClasses } = signals;
  const suggestions: TuningSuggestion[] = [];
  const totalCalls = summary.tools.reduce((sum, row) => sum + row.count, 0);
  const top = summary.tools[0];
  const dominantClass = failureClasses[0];

  if (summary.tools.length === 0) {
    suggestions.push({
      id: "tool-telemetry",
      area: "telemetry",
      severity: "info",
      title: "no tool-call telemetry",
      detail:
        "No post-mortem records toolCalls. Record a name→count map on each post-mortem before tuning tools; histograms and suggestions are unavailable without it.",
      priority: 10,
    });
  } else {
    if (top !== undefined && totalCalls >= TUNING_MIN_TOOL_CALLS && top.count / totalCalls >= TUNING_DOMINANT_TOOL_RATE) {
      const pct = Math.round((top.count / totalCalls) * 100);
      suggestions.push({
        id: "dominant-tool",
        area: "tool",
        severity: "warn",
        title: `dominant tool: ${top.tool}`,
        detail: `${top.tool} is ${top.count}/${totalCalls} tool calls (${pct}%, ≥ ${Math.round(TUNING_DOMINANT_TOOL_RATE * 100)}%). Batch or scope its calls (range reads, one grep over many) and add a prompt line steering the model to a more targeted tool.`,
        priority: 20,
      });
    }
    const shell = summary.tools.find((row) => row.tool === "shell");
    if (shell !== undefined && shell.count >= TUNING_MIN_SHELL_CALLS) {
      suggestions.push({
        id: "shell-heavy",
        area: "tool",
        severity: "info",
        title: "shell-heavy corpus",
        detail: `shell has ${shell.count} calls (≥ ${TUNING_MIN_SHELL_CALLS}). Prefer dedicated read/grep/glob tools for inspection and reserve shell for mutations; tighten the shell tool prompt accordingly.`,
        priority: 30,
      });
    }
  }

  if (outcomeCount >= TUNING_MIN_RECORDS && failed / outcomeCount >= TUNING_FAILURE_RATE) {
    const cls = dominantClass === undefined ? "unknown" : `${dominantClass[0]} (${dominantClass[1]})`;
    suggestions.push({
      id: "high-failure-rate",
      area: "prompt",
      severity: "warn",
      title: "high failure rate",
      detail: `${failed}/${outcomeCount} post-mortems ended 'failed' (≥ ${Math.round(TUNING_FAILURE_RATE * 100)}%), dominant failure class ${cls}. Add a corrective prompt guard for that class and tune the responsible tool's retry/limit settings.`,
      priority: 15,
    });
  }
  if (dominantClass !== undefined && dominantClass[1] >= 2 && dominantClass[0] === "tool_error") {
    suggestions.push({
      id: "tool-error-class",
      area: "tool",
      severity: "warn",
      title: "tool_error failures",
      detail: `${dominantClass[1]} post-mortems are failure class tool_error. Audit the failing tool's schema/validation and add a prompt hint with one valid invocation example.`,
      priority: 25,
    });
  }
  if (dominantClass !== undefined && dominantClass[1] >= 2 && dominantClass[0] === "budget") {
    suggestions.push({
      id: "budget-class",
      area: "prompt",
      severity: "info",
      title: "budget failures",
      detail: `${dominantClass[1]} post-mortems are failure class budget. Tighten the output budget / compaction prompt and lower per-turn tool result caps.`,
      priority: 35,
    });
  }
  if (unknown > 0) {
    suggestions.push({
      id: "unknown-terminal",
      area: "telemetry",
      severity: "info",
      title: "unclassified terminals",
      detail: `${unknown} post-mortem(s) ended 'unknown'. Improve terminal classification at the source so tuning signals are not diluted.`,
      priority: 40,
    });
  }

  suggestions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return suggestions;
}

/** H-7/ruling 510: contracted blocks for the suggestions' numeric claims. */
function publishedSuggestions(suggestions: readonly TuningSuggestion[], population: string): string[] {
  return [
    metricContract({
      metric: "tuning suggestions emitted",
      anchor: CORPUS_ANCHOR,
      population,
      excludes: SUGGESTION_EXCLUDES,
      value: suggestions.length,
    }),
    ...suggestions.map((s) =>
      metricContract({
        metric: `tuning suggestion ${s.id} (${s.area}/${s.severity})`,
        anchor: CORPUS_ANCHOR,
        population,
        excludes: SUGGESTION_EXCLUDES,
        value: s.detail,
      }),
    ),
  ];
}

/**
 * Derive concrete tool/prompt tuning suggestions from a loaded corpus.
 * Every suggestion cites an observed count and a threshold; nothing writes to
 * a session, nor calls the network. Deterministic for a given record list.
 */
export function suggestCorpusTuning(records: readonly PostmortemRecord[]): CorpusTuningReport {
  const summary = histogramFromPostmortems(records);
  const population = corpusPopulation(records.length);
  const suggestions = deriveSuggestions({
    summary,
    failed: summary.terminals.failed ?? 0,
    unknown: summary.terminals.unknown ?? 0,
    outcomeCount: records.length,
    failureClasses: failureClassCounts(records),
    population,
  });
  return {
    summary,
    suggestions,
    published: [...summary.published, ...publishedSuggestions(suggestions, population)],
  };
}

/** Human-readable optimiser report (summary + concrete suggestions). */
export function renderCorpusTuningReport(report: CorpusTuningReport): string {
  const lines = [renderSessionCorpusSummary(report.summary), ""];
  if (report.suggestions.length === 0) {
    lines.push("tuning suggestions: (none — corpus looks tuned)");
    return lines.join("\n");
  }
  lines.push(`tuning suggestions (${report.suggestions.length}):`);
  for (const s of report.suggestions) {
    lines.push(`  [${s.severity}/${s.area}] ${s.title}`);
    lines.push(`    ${s.detail}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Full-corpus readers (J-5 follow-up): session DB + Markdown transcripts     */
/* -------------------------------------------------------------------------- */
/*
 * Everything here is bounded and READ-ONLY. The SQLite DB is opened in readonly
 * mode (never created, migrated, chmod'd or quarantined); Markdown transcripts
 * and post-mortems are read from disk. A missing/empty corpus is a healthy zero
 * result, and malformed rows are SKIPPED with a count (never crash, never
 * silently treated as a different value). No network, no writes.
 */

/** Bounds so a pathological corpus cannot exhaust memory (read-only). */
export const MAX_CORPUS_SESSIONS = 500;
export const MAX_CORPUS_MESSAGES = 5000;
export const MAX_CORPUS_TRANSCRIPTS = 500;
export const MAX_CORPUS_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

/** Tool name → count from a transcript's ChatMsg list (tool-result messages). */
export function toolCountsFromMessages(messages: readonly ChatMsg[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const name = msg.toolName;
    if (typeof name !== "string" || name.trim() === "") continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [name, count] of Object.entries(from)) {
    if (typeof count !== "number" || count < 1) continue;
    into[name] = (into[name] ?? 0) + count;
  }
}

export interface SessionDbCorpus {
  toolCalls: Record<string, number>;
  sessions: number;
  messages: number;
  /** Malformed rows skipped (not a tool count, not a crash). */
  skipped: number;
  truncated: boolean;
  error?: string;
}

function emptySessionDbCorpus(): SessionDbCorpus {
  return { toolCalls: {}, sessions: 0, messages: 0, skipped: 0, truncated: false };
}

/** Whether a raw DB row has the shape `rowToChatMsg` expects. */
function isMessageRow(row: unknown): row is { role: string; content: string | null; meta: string | null } {
  if (row === null || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  return (
    typeof value.role === "string" &&
    (value.content === null || value.content === undefined || typeof value.content === "string") &&
    (value.meta === null || value.meta === undefined || typeof value.meta === "string")
  );
}

/** True when a `meta` cell carries malformed JSON (skipped, never misread). */
function malformedMeta(meta: string | null): boolean {
  if (!meta) return false;
  try {
    const value: unknown = JSON.parse(meta);
    return value === null || typeof value !== "object" || Array.isArray(value);
  } catch {
    return true;
  }
}

/**
 * Read tool-usage counts from the workspace's session DB, read-only and bounded.
 * Tool rows are counted via `toolName` (the same signal the loop records on
 * post-mortems), so DB and transcript counts are directly comparable.
 */
export function readSessionDbCorpus(
  workspace: string,
  opts: { maxSessions?: number; maxMessages?: number } = {},
): SessionDbCorpus {
  const maxSessions = Number.isFinite(opts.maxSessions) ? Math.max(1, Math.floor(opts.maxSessions as number)) : MAX_CORPUS_SESSIONS;
  const maxMessages = Number.isFinite(opts.maxMessages) ? Math.max(1, Math.floor(opts.maxMessages as number)) : MAX_CORPUS_MESSAGES;
  if (typeof workspace !== "string" || workspace.trim() === "") {
    return { ...emptySessionDbCorpus(), error: "workspace is required" };
  }
  const dbPath = sessionDbPath(workspace);
  if (!existsSync(dbPath)) return emptySessionDbCorpus();
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    if (!names.has("sessions") || !names.has("messages")) return emptySessionDbCorpus();
    const sessionRows = db
      .query("SELECT id FROM sessions ORDER BY rowid DESC LIMIT ?")
      .all(maxSessions + 1) as Array<{ id: unknown }>;
    let truncated = sessionRows.length > maxSessions;
    const ids = sessionRows.slice(0, maxSessions).map((r) => r.id).filter((id): id is string => typeof id === "string" && id !== "");
    const toolCalls: Record<string, number> = {};
    let messages = 0;
    let skipped = 0;
    const stmt = db.query("SELECT role, content, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC LIMIT ?");
    for (const id of ids) {
      let rows: unknown[];
      try {
        rows = stmt.all(id, maxMessages + 1);
      } catch {
        skipped += 1;
        continue;
      }
      if (rows.length > maxMessages) truncated = true;
      for (const raw of rows.slice(0, maxMessages)) {
        if (!isMessageRow(raw)) {
          skipped += 1;
          continue;
        }
        if (malformedMeta(raw.meta)) skipped += 1;
        try {
          mergeCounts(toolCalls, toolCountsFromMessages([rowToChatMsg(raw)]));
          messages += 1;
        } catch {
          skipped += 1;
        }
      }
    }
    return { toolCalls, sessions: ids.length, messages, skipped, truncated };
  } catch (err) {
    return { ...emptySessionDbCorpus(), error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
}

export interface TranscriptCorpus {
  toolCalls: Record<string, number>;
  transcripts: number;
  skipped: number;
  truncated: boolean;
  error?: string;
}

function emptyTranscriptCorpus(): TranscriptCorpus {
  return { toolCalls: {}, transcripts: 0, skipped: 0, truncated: false };
}

/**
 * Read tool-usage counts from `<state>/transcripts/*.md`, read-only and bounded.
 * Files that are unreadable or over the byte cap are skipped with a count.
 */
export function readMarkdownTranscriptCorpus(
  workspace: string,
  opts: { maxTranscripts?: number; maxBytes?: number } = {},
): TranscriptCorpus {
  const maxTranscripts = Number.isFinite(opts.maxTranscripts)
    ? Math.max(1, Math.floor(opts.maxTranscripts as number))
    : MAX_CORPUS_TRANSCRIPTS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, Math.floor(opts.maxBytes as number)) : MAX_CORPUS_TRANSCRIPT_BYTES;
  if (typeof workspace !== "string" || workspace.trim() === "") {
    return { ...emptyTranscriptCorpus(), error: "workspace is required" };
  }
  const dir = path.join(workspaceStateDir(workspace), "transcripts");
  if (!existsSync(dir)) return emptyTranscriptCorpus();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch (err) {
    return { ...emptyTranscriptCorpus(), error: err instanceof Error ? err.message : String(err) };
  }
  const truncated = names.length > maxTranscripts;
  const toolCalls: Record<string, number> = {};
  let transcripts = 0;
  let skipped = 0;
  for (const name of names.slice(0, maxTranscripts)) {
    const file = path.join(dir, name);
    try {
      if (statSync(file).size > maxBytes) {
        skipped += 1;
        continue;
      }
      const parsed = parseMarkdownTranscript(readFileSync(file, "utf8"));
      mergeCounts(toolCalls, toolCountsFromMessages(parsed.messages));
      transcripts += 1;
    } catch {
      skipped += 1;
    }
  }
  return { toolCalls, transcripts, skipped, truncated };
}

export interface FullCorpusTuningReport extends CorpusTuningReport {
  sources: {
    postmortems: number;
    sessionDb: SessionDbCorpus;
    transcripts: TranscriptCorpus;
  };
  counts: {
    toolCalls: number;
    skipped: number;
    truncated: boolean;
  };
}

/**
 * Run the optimiser over the FULL corpus: post-mortems + session DB + Markdown
 * transcripts. Session/transcript tool counts are folded in as one synthetic
 * "succeeded" outcome so the failure-rate denominator stays the real
 * post-mortem count while tool histograms and suggestions see the whole corpus.
 * Bounded, read-only, deterministic.
 */
export async function buildWorkspaceCorpusReport(
  workspace: string,
  stateDir: string = workspaceStateDir(workspace),
): Promise<FullCorpusTuningReport> {
  const loaded = await loadPostmortems(stateDir);
  const sessionDb = readSessionDbCorpus(workspace);
  const transcripts = readMarkdownTranscriptCorpus(workspace);

  const records: PostmortemRecord[] = [...loaded.postmortems];
  const merged: Record<string, number> = {};
  mergeCounts(merged, sessionDb.toolCalls);
  mergeCounts(merged, transcripts.toolCalls);
  if (Object.keys(merged).length > 0) {
    records.push({
      id: "session-corpus",
      sessionId: "session-corpus",
      ts: "",
      terminal: "succeeded",
      detail: null,
      failureClass: "unknown",
      task: null,
      transcript: { firstSeq: null, lastSeq: null, count: 0, textDigest: "" },
      toolCalls: merged,
      failureDigest: "",
    } as PostmortemRecord);
  }

  const summary = histogramFromPostmortems(records);
  const population = `full session corpus for ${workspace}: ${loaded.postmortems.length} post-mortem(s), ${sessionDb.sessions} session(s), ${transcripts.transcripts} transcript(s)`;
  const suggestions = deriveSuggestions({
    summary,
    failed: summary.terminals.failed ?? 0,
    unknown: summary.terminals.unknown ?? 0,
    outcomeCount: loaded.postmortems.length,
    failureClasses: failureClassCounts(loaded.postmortems),
    population,
  });
  const skipped = sessionDb.skipped + transcripts.skipped + loaded.quarantine.length;
  const truncated = sessionDb.truncated || transcripts.truncated;
  const published = [
    ...summary.published,
    ...publishedSuggestions(suggestions, population),
    ...[
      metricContract({
        metric: "session DB rows scanned",
        anchor: "none — first measurement (no prior corpus snapshot to compare against)",
        population,
        excludes: "malformed rows are skipped, never counted as tool calls",
        value: sessionDb.messages,
      }),
      metricContract({
        metric: "malformed corpus rows skipped",
        anchor: "none — first measurement (no prior corpus snapshot to compare against)",
        population,
        excludes: "none — every skipped row contributes one",
        value: skipped,
      }),
      metricContract({
        metric: "corpus scan hit a read bound",
        anchor: "none — first measurement (no prior corpus snapshot to compare against)",
        population,
        excludes: "none — a boolean of the configured read caps",
        value: truncated ? 1 : 0,
      }),
    ],
  ];
  return {
    summary,
    suggestions,
    published,
    sources: { postmortems: loaded.postmortems.length, sessionDb, transcripts },
    counts: {
      toolCalls: summary.tools.reduce((sum, row) => sum + row.count, 0),
      skipped,
      truncated,
    },
  };
}

/** One bounded, deterministic sources line for the full-corpus renderers. */
function corpusSourceLine(report: FullCorpusTuningReport): string {
  const { postmortems, sessionDb, transcripts } = report.sources;
  return (
    `corpus sources: postmortems=${postmortems}, sessions=${sessionDb.sessions}, transcripts=${transcripts.transcripts}, ` +
    `messages=${sessionDb.messages}, skipped=${report.counts.skipped}, truncated=${report.counts.truncated ? "yes" : "no"}`
  );
}

/** Human summary of the full corpus (no suggestions) — bounded + read-only. */
export function renderFullCorpusSummary(report: FullCorpusTuningReport): string {
  return `${renderSessionCorpusSummary(report.summary)}\n${corpusSourceLine(report)}`;
}

/** Human optimiser report over the full corpus (summary + concrete suggestions). */
export function renderFullCorpusTuningReport(report: FullCorpusTuningReport): string {
  return `${renderCorpusTuningReport(report)}\n${corpusSourceLine(report)}`;
}

/**
 * compaction.ts — constraint-preserving compaction of the provider view.
 *
 * The loop used to hand the provider `trimHistory(store.history(...))`: past 80
 * messages the oldest turns were sliced off with nothing left behind to say it
 * had happened. That is how a turn-1 constraint — the original task statement, a
 * "do not touch app/src/tools/*.ts" rule — disappeared after ~40 turns while the
 * transcript and the UI both looked complete.
 *
 * This module makes the window boundary explicit instead of silent:
 *
 *   1. PINNED CONSTRAINTS are derived from the transcript itself, never from a
 *      model call and never from a guess: the first user message verbatim, plus
 *      every constraint-shaped line a later user/system turn stated. Derivation
 *      reads the rows on every dispatch, so the block cannot be lost by a crash
 *      (there is no in-memory copy to lose) and cannot be compacted away (it is
 *      rebuilt from the messages that would have to be deleted to lose it).
 *   2. The elided prefix is SUMMARISED and labelled, and the summary is merged
 *      into the surviving window's first user turn. The model can therefore see
 *      that it is reading a compaction, not the whole conversation.
 *   3. The result REPORTS what it dropped (`dropped`, `droppedByRole`) and a
 *      one-line notice for the UI, so a compaction is observable rather than
 *      inferred. Nothing is ever compacted silently.
 *   4. It is a PURE function of (messages, limit). The SQLite transcript is not
 *      rewritten — this is a view. A mid-turn kill loses no compaction state,
 *      because the next dispatch re-derives it from the same rows.
 *
 * Two properties the tests pin:
 *
 *   - Idempotence: at or under the limit the input is returned unchanged and
 *     the same array reference is handed back; a compacted view is at or under
 *     the limit by construction, so composing it again is a no-op and markers
 *     can never nest.
 *   - Replay validity: the window still starts at a user turn (the rule
 *     `trimHistory` documented), and merging into that turn rather than
 *     prepending a new one keeps the user/assistant alternation the providers
 *     expect — one user turn, not two in a row.
 */

import type { ChatMsg } from "../contracts";
import { estimateTokens, FRAMING_CHARGE_TOKENS } from "./output-budget";

/** The headings are contract, not prose: tests and the model both key off them. */
export const PINNED_HEADING = "## Pinned constraints (verbatim, never compacted)";
export const SUMMARY_HEADING = "## Summary of elided turns (compacted)";

/**
 * The audit-trail event type for one compaction. `EventType` is intentionally
 * open (contracts.ts:72, `| string`) and nothing switches on event types, so a
 * new name needs no contract change — but the name may not be implicit: a
 * compaction the log cannot show is the silent slice this module replaces.
 */
export const COMPACTION_EVENT = "session.compaction";

/** Between the injected block and the user's own words, so both stay legible. */
export const COMPACTION_SEPARATOR = "\n\n---\n\n";

/** The task statement is carried verbatim; only an absurd one is cut. */
export const MAX_TASK_STATEMENT_CHARS = 2_000;
/** The pinned block is always sent, so it is bounded: 24 lines, 300 chars each. */
export const MAX_CONSTRAINT_LINES = 24;
export const MAX_CONSTRAINT_LINE_CHARS = 300;
export const MAX_SUMMARY_ECHO_CHARS = 160;
export const MAX_SUMMARY_PATHS = 8;

/**
 * Words that mark a line as a standing instruction rather than a passing
 * remark. Deliberately a short, boring list: a false positive costs context on
 * every single dispatch, a false negative costs one constraint, and the task
 * statement (always carried verbatim) catches most of what this misses.
 */
const CONSTRAINT_SIGNALS = ["must", "never", "do not", "don't", "exactly", "required", "constraint", "shall"] as const;

const BULLET = /^\s*(?:[-*+\u2022]|\d+[.)]|>|#{1,6})\s*/;

/** Curly apostrophes are normalised so a pasted "don’t" still matches. */
function normalise(line: string): string {
  return line.replace(/\u2019/g, "'").trim();
}

function isWordBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s():,.;!\-)\]"']/.test(char);
}

/**
 * Does this line read as a standing constraint? Exported because the rule is a
 * judgement call and deserves its own tests rather than coverage by accident.
 */
export function looksLikeConstraint(line: string): boolean {
  const text = normalise(line);
  if (text.length < 8) return false;
  // A question is a request for information, not an instruction to persist.
  if (text.endsWith("?")) return false;
  const lower = text.toLowerCase();
  return CONSTRAINT_SIGNALS.some((signal) => {
    let at = lower.indexOf(signal);
    while (at !== -1) {
      const before = at === 0 ? undefined : lower[at - 1];
      const after = lower[at + signal.length];
      if ((at === 0 || isWordBoundary(before)) && isWordBoundary(after)) return true;
      at = lower.indexOf(signal, at + 1);
    }
    return false;
  });
}

/**
 * Constraint lines inside one message. Fenced code is skipped: a constraint in
 * a code block is usually an example of code, not an instruction to the agent.
 */
export function constraintLines(content: string): string[] {
  const text = typeof content === "string" ? content : "";
  if (text === "") return [];
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = normalise(raw.replace(BULLET, ""));
    if (line === "") continue;
    const capped = line.length > MAX_CONSTRAINT_LINE_CHARS ? `${line.slice(0, MAX_CONSTRAINT_LINE_CHARS)}…` : line;
    if (looksLikeConstraint(capped)) out.push(capped);
  }
  return out;
}

export interface PinnedConstraints {
  /** The first non-empty user message, verbatim (the original task statement). */
  taskStatement: string | null;
  taskStatementTruncated: boolean;
  /** Every constraint-shaped user/system line, in first-seen order, deduped. */
  constraints: string[];
  /** Matched lines that did not fit MAX_CONSTRAINT_LINES (reported, not hidden). */
  constraintsDropped: number;
  scannedMessages: number;
}

export interface CompactionResult {
  /** What the provider should see. Identity-equal to the input when not compacted. */
  history: ChatMsg[];
  compacted: boolean;
  /** Messages elided from the provider view (still present in the store). */
  dropped: number;
  kept: number;
  /** Approximate tokens removed from the provider view, by the loop's estimator. */
  elidedTokens: number;
  droppedByRole: Record<string, number>;
  /** Populated only when `compacted`; null keeps the no-op path cheap. */
  pinned: PinnedConstraints | null;
  /** The labelled summary text merged into the window ("" when not compacted). */
  summary: string;
  /** One line for the UI ("" when not compacted). */
  notice: string;
}

function countByRole(messages: readonly ChatMsg[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "unknown";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

function formatByRole(counts: Record<string, number>): string {
  return Object.keys(counts)
    .sort()
    .map((role) => `${role} ${counts[role]}`)
    .join(" / ");
}

function echo(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY_ECHO_CHARS ? `${flat.slice(0, MAX_SUMMARY_ECHO_CHARS)}…` : flat;
}

/** Best-effort path extraction from one tool call's raw arguments. */
function pathsInArguments(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^(?:path|file|file_path|filepath|target|dir|directory)$/i.test(key)) continue;
    if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
  }
  return out;
}

/**
 * Derive the pinned block from the transcript. Pure, synchronous and total:
 * malformed rows are skipped rather than throwing, because this runs on the
 * dispatch path where a throw would cost the user their turn.
 */
export function pinnedConstraintsFrom(messages: readonly ChatMsg[]): PinnedConstraints {
  const list = Array.isArray(messages) ? messages : [];
  let taskStatement: string | null = null;
  let taskStatementTruncated = false;
  const seen = new Set<string>();
  const constraints: string[] = [];
  let constraintsDropped = 0;
  let scannedMessages = 0;

  for (const message of list) {
    if (message === null || typeof message !== "object") continue;
    scannedMessages += 1;
    const content = typeof message.content === "string" ? message.content : "";
    if (content.trim() === "") continue;

    const isStatementMessage = taskStatement === null && message.role === "user";
    if (isStatementMessage) {
      const trimmed = content.trim();
      if (trimmed.length > MAX_TASK_STATEMENT_CHARS) {
        taskStatement = `${trimmed.slice(0, MAX_TASK_STATEMENT_CHARS)} [truncated at ${MAX_TASK_STATEMENT_CHARS} chars]`;
        taskStatementTruncated = true;
      } else {
        taskStatement = trimmed;
      }
    }

    if (message.role !== "user" && message.role !== "system") continue;
    for (const line of constraintLines(content)) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // The statement itself is pinned verbatim on the system rail (loop.ts
      // `pinnedTaskStatement`), where no history transformation reaches it. So a
      // constraint-shaped line inside the statement MUST become a bullet here:
      // suppressing it (the pre-split rule) would delete the task's own
      // constraints from the provider view, since this block no longer carries
      // the statement. The rail is a second copy, not a replacement for the list.
      if (constraints.length >= MAX_CONSTRAINT_LINES) {
        constraintsDropped += 1;
        continue;
      }
      constraints.push(line);
    }
  }

  return { taskStatement, taskStatementTruncated, constraints, constraintsDropped, scannedMessages };
}

/** Render the block that is prepended to the window. Stable, deterministic text. */
export function renderPinnedBlock(pinned: PinnedConstraints): string {
  const lines = [PINNED_HEADING, ""];
  // One copy, not two: the statement is pinned verbatim on the system rail
  // (loop.ts `pinnedTaskStatement`), out of reach of any history rewriting. This
  // block keeps the constraint bullets and the elision report.
  if (pinned.taskStatement !== null) {
    lines.push("Original task statement: pinned verbatim on the system rail.", "");
  } else {
    lines.push("Original task statement: not present in the visible transcript.", "");
  }
  if (pinned.constraints.length > 0) {
    lines.push("Explicit constraints stated in the transcript:");
    for (const constraint of pinned.constraints) lines.push(`- ${constraint}`);
    if (pinned.constraintsDropped > 0) {
      lines.push(`- (${pinned.constraintsDropped} further constraint line(s) omitted at the ${MAX_CONSTRAINT_LINES}-line cap)`);
    }
  } else {
    lines.push("Explicit constraints: none detected in user or system turns.");
  }
  return lines.join("\n");
}

/** Tokens in a set of messages, using the loop's own accounting. */
function tokensIn(messages: readonly ChatMsg[]): number {
  let total = 0;
  for (const message of messages) {
    total += FRAMING_CHARGE_TOKENS + estimateTokens(typeof message?.content === "string" ? message.content : "");
    for (const call of message?.toolCalls ?? []) total += estimateTokens(typeof call?.arguments === "string" ? call.arguments : "");
  }
  return total;
}

/** The labelled summary of what left the window. */
export function summariseElided(elided: readonly ChatMsg[], total: number, limit: number): string {
  const byRole = countByRole(elided);
  const firstUser = elided.find((message) => message?.role === "user" && (message.content ?? "").trim() !== "");
  let lastUser: ChatMsg | undefined;
  for (let i = elided.length - 1; i >= 0; i -= 1) {
    const message = elided[i];
    if (message?.role === "user" && (message.content ?? "").trim() !== "") {
      lastUser = message;
      break;
    }
  }

  const tools = new Set<string>();
  const paths = new Set<string>();
  for (const message of elided) {
    if (typeof message?.toolName === "string" && message.toolName !== "") tools.add(message.toolName);
    for (const call of message?.toolCalls ?? []) {
      if (typeof call?.name === "string" && call.name !== "") tools.add(call.name);
      for (const candidate of pathsInArguments(call?.arguments)) {
        if (paths.size >= MAX_SUMMARY_PATHS) break;
        paths.add(candidate);
      }
    }
  }

  const lines = [
    SUMMARY_HEADING,
    "",
    `${elided.length} of ${total} messages left the ${limit}-message window (~${tokensIn(elided)} tokens).`,
    `- roles elided: ${formatByRole(byRole) || "none"}`,
  ];
  if (firstUser) lines.push(`- first elided request: "${echo(firstUser.content)}"`);
  if (lastUser && lastUser !== firstUser) lines.push(`- last elided request: "${echo(lastUser.content)}"`);
  if (tools.size > 0) lines.push(`- tools called in the elided turns: ${[...tools].join(", ")}`);
  if (paths.size > 0) lines.push(`- paths seen in the elided turns: ${[...paths].join(", ")}`);
  lines.push("- the full transcript is unchanged in the session store; this block is a view, not a deletion.");
  return lines.join("\n");
}

export interface CompactionOptions {
  /** Messages the provider view may hold, the loop's HISTORY_LIMIT. */
  limit: number;
}

/** The one line the UI shows. Kept under ~250 chars so a notice stays a notice. */
export function renderCompactionNotice(result: CompactionResult): string {
  if (!result.compacted) return "";
  const pinnedCount = result.pinned?.constraints.length ?? 0;
  const taskLine = result.pinned?.taskStatement ? "the task statement pinned on the system rail" : "no task statement found";
  const total = result.dropped + result.kept;
  return (
    `compaction: ${result.dropped} of ${total} message(s) elided (~${result.elidedTokens} tokens; ${formatByRole(result.droppedByRole)}), ` +
    `window kept at ${result.kept} — ${taskLine} and ${pinnedCount} constraint line(s) pinned; the transcript is unchanged`
  );
}

function unchanged(messages: ChatMsg[]): CompactionResult {
  return {
    history: messages,
    compacted: false,
    dropped: 0,
    kept: messages.length,
    elidedTokens: 0,
    droppedByRole: {},
    pinned: null,
    summary: "",
    notice: "",
  };
}

/**
 * Compact the provider view: elide a prefix, keep a window that starts at a user
 * turn, and merge a labelled pinned+summary block into that first user message.
 *
 * Nothing is mutated: the surviving first turn is copied before its content is
 * rewritten, so a caller holding the store's array sees it unchanged.
 */
export function compactHistory(messages: ChatMsg[], options: CompactionOptions): CompactionResult {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Number.isFinite(options?.limit) && (options?.limit ?? 0) >= 1 ? Math.floor(options.limit) : 1;
  if (list.length <= limit) return unchanged(list);

  // Mirrors trimHistory's contract: the window starts at a user turn so the
  // replay cannot open on an orphan tool result or a dangling assistant call.
  const window = list.slice(-limit);
  while (window.length > 0 && window[0]?.role !== "user") window.shift();
  if (window.length === 0) return unchanged(list);

  const elided = list.slice(0, list.length - window.length);
  if (elided.length === 0) return unchanged(list);

  const pinned = pinnedConstraintsFrom(list);
  const summary = summariseElided(elided, list.length, limit);
  const first = window[0] as ChatMsg;
  // Merge rather than prepend: one user turn, so user/assistant alternation is
  // preserved and the pinned block is the first thing every request carries.
  const merged: ChatMsg = {
    ...first,
    content: `${renderPinnedBlock(pinned)}${COMPACTION_SEPARATOR}${summary}${COMPACTION_SEPARATOR}${first.content ?? ""}`,
  };
  const history = [merged, ...window.slice(1)];

  const result: CompactionResult = {
    history,
    compacted: true,
    dropped: elided.length,
    kept: history.length,
    elidedTokens: tokensIn(elided),
    droppedByRole: countByRole(elided),
    pinned,
    summary,
    notice: "",
  };
  result.notice = renderCompactionNotice(result);
  return result;
}

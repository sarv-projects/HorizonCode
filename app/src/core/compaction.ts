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
/** Structured-summary caps (T-7): newest entries win, older ones are counted, not listed. */
export const MAX_SUMMARY_FILES = 20;
export const MAX_SUMMARY_COMMANDS = 8;
export const MAX_SUMMARY_SEARCHES = 6;
export const MAX_SUMMARY_TODO_ITEMS = 5;
export const MAX_SUMMARY_COMMAND_CHARS = 120;
export const MAX_SUMMARY_PATH_CHARS = 80;
/** Hard ceiling on the whole summary block, so compaction cannot balloon the window. */
export const MAX_SUMMARY_CHARS = 2_500;

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

/** One tool call's raw arguments as an object; malformed JSON yields {} (never throws). */
function argsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Best-effort path extraction from one tool call's parsed arguments. */
function pathsInArguments(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!/^(?:path|file|file_path|filepath|target|dir|directory)$/i.test(key)) continue;
    if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
  }
  return out;
}

/** What a builtin tool does, for the summary. Anything else is reported by its own name. */
export type SummaryOp = "read" | "edit" | "write" | "delete" | "search" | "shell" | "todo" | "patch" | "undo" | "other";

/** Pure tool-name classifier over the builtin tool names in app/src/tools/. */
export function classifyTool(name: string): SummaryOp {
  switch (name) {
    case "read":
      return "read";
    case "edit":
    case "ast_edit":
      return "edit";
    case "write":
      return "write";
    case "apply_patch":
      return "patch";
    case "undo":
      return "undo";
    case "grep":
    case "glob":
    case "ast_search":
      return "search";
    case "shell":
    case "shell_session":
      return "shell";
    case "todo":
      return "todo";
    default:
      return "other";
  }
}

/** Per-file ops named by an apply_patch envelope's headers (no body parsing). */
function patchOps(input: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let current = "";
  for (const line of input.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = (header[2] as string).trim();
      const op = header[1] === "Add" ? "write" : header[1] === "Delete" ? "delete" : "edit";
      if (current !== "") out.push([current, op]);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current !== "") {
      const to = (move[1] as string).trim();
      out.push([current, `moved to ${to}`]);
      if (to !== "") out.push([to, "edit"]);
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Long paths keep their tail (the file name is the useful end). */
function clipPath(path: string): string {
  return path.length > MAX_SUMMARY_PATH_CHARS ? `…${path.slice(path.length - MAX_SUMMARY_PATH_CHARS)}` : path;
}

/** The newest `max` entries, with a count of the older ones left out. */
function newest<T>(items: readonly T[], max: number): { shown: T[]; omitted: number } {
  return items.length > max ? { shown: items.slice(items.length - max), omitted: items.length - max } : { shown: [...items], omitted: 0 };
}

interface ElidedActivity {
  tools: string[];
  /** path -> last op, iteration order = order of last touch */
  files: Map<string, string>;
  commands: string[];
  searches: string[];
  todoAdded: string[];
  todoDone: string[];
}

/** Walk the elided tool calls in order. Pure and total: odd rows are skipped. */
function elidedActivity(elided: readonly ChatMsg[]): ElidedActivity {
  const tools = new Set<string>();
  const files = new Map<string, string>();
  const touch = (path: string, op: string): void => {
    files.delete(path);
    files.set(path, op);
  };
  const commands: string[] = [];
  const searches: string[] = [];
  const todoAdded: string[] = [];
  const todoDone: string[] = [];

  for (const message of elided) {
    if (typeof message?.toolName === "string" && message.toolName !== "") tools.add(message.toolName);
    for (const call of message?.toolCalls ?? []) {
      const name = typeof call?.name === "string" ? call.name : "";
      if (name === "") continue;
      tools.add(name);
      const args = argsOf(call?.arguments);
      const op = classifyTool(name);
      switch (op) {
        case "read":
        case "edit":
        case "write":
        case "undo":
          for (const path of pathsInArguments(args)) touch(path, op);
          break;
        case "patch":
          for (const [path, patchOp] of patchOps(str(args.input))) touch(path, patchOp);
          break;
        case "search": {
          const pattern = str(args.pattern) || str(args.pat);
          if (pattern === "") break;
          const where = str(args.path);
          const glob = str(args.glob);
          searches.push(
            `${name} "${clip(pattern, MAX_SUMMARY_COMMAND_CHARS)}"${where !== "" ? ` in ${where}` : ""}${glob !== "" && name !== "glob" ? ` (${glob})` : ""}`,
          );
          break;
        }
        case "shell": {
          // shell_session `write` feeds stdin; only a started command is a command run.
          const command = name === "shell_session" && str(args.mode) !== "start" ? "" : str(args.command);
          if (command !== "") commands.push(clip(command, MAX_SUMMARY_COMMAND_CHARS));
          break;
        }
        case "todo": {
          const action = str(args.action);
          const text = str(args.text);
          if (action === "add" && text !== "") todoAdded.push(clip(text, 60));
          else if (action === "done" && text !== "") todoDone.push(clip(text, 60));
          break;
        }
        default:
          for (const path of pathsInArguments(args)) touch(path, name);
      }
    }
  }
  return { tools: [...tools], files, commands, searches, todoAdded, todoDone };
}

function quotedList(items: readonly string[], max: number): string {
  const { shown, omitted } = newest(items, max);
  return shown.map((item) => `"${item}"`).join(", ") + (omitted > 0 ? ` (+${omitted} earlier)` : "");
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

/**
 * The labelled summary of what left the window: role counts, first and last
 * request, and what the elided tool calls DID (each file's last op, commands
 * run, searches, todo changes). Derived only from the elided rows' tool-call
 * arguments, so it is a pure function of (elided, total, limit), and it never
 * exceeds MAX_SUMMARY_CHARS. Tool results are not parsed: a failed call is
 * reported as attempted, since result text carries no reliable error marker.
 */
/** Mask secret-like values in a command line before it reaches the summary. */
export function maskSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\b(gh[pousr]_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/((?:token|key|secret|password|passwd|pwd|apikey|api_key|api-key|auth)[A-Za-z0-9_-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1***");
}

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

  const activity = elidedActivity(elided);

  const head = [
    SUMMARY_HEADING,
    "",
    `${elided.length} of ${total} messages left the ${limit}-message window (~${tokensIn(elided)} tokens).`,
    `- roles elided: ${formatByRole(byRole) || "none"}`,
  ];
  // Body lines are optional detail: each section is omitted when empty, and the
  // whole block is cut at MAX_SUMMARY_CHARS line by line (never mid-line).
  const body: string[] = [];
  if (firstUser) body.push(`- first elided request: "${echo(firstUser.content)}"`);
  if (lastUser && lastUser !== firstUser) body.push(`- last elided request: "${echo(lastUser.content)}"`);
  if (activity.tools.length > 0) body.push(`- tools called in the elided turns: ${activity.tools.join(", ")}`);
  if (activity.files.size > 0) {
    const { shown, omitted } = newest([...activity.files], MAX_SUMMARY_FILES);
    body.push(
      `- files touched (last op, oldest first): ${shown.map(([path, op]) => `${clipPath(path)} (${op})`).join(", ")}` +
        (omitted > 0 ? ` (+${omitted} earlier)` : ""),
    );
  }
  if (activity.commands.length > 0) {
    const { shown, omitted } = newest(activity.commands, MAX_SUMMARY_COMMANDS);
    body.push(`- commands run (oldest first${omitted > 0 ? `, ${omitted} earlier omitted` : ""}):`);
    for (const command of shown) body.push(`  - \`${maskSecrets(command)}\``);
  }
  if (activity.searches.length > 0) {
    const { shown, omitted } = newest(activity.searches, MAX_SUMMARY_SEARCHES);
    body.push(`- searches: ${shown.join("; ")}${omitted > 0 ? ` (+${omitted} earlier)` : ""}`);
  }
  if (activity.todoAdded.length > 0 || activity.todoDone.length > 0) {
    const parts: string[] = [];
    if (activity.todoAdded.length > 0) parts.push(`added ${activity.todoAdded.length}: ${quotedList(activity.todoAdded, MAX_SUMMARY_TODO_ITEMS)}`);
    if (activity.todoDone.length > 0) parts.push(`done ${activity.todoDone.length}: ${quotedList(activity.todoDone, MAX_SUMMARY_TODO_ITEMS)}`);
    body.push(`- todo changes: ${parts.join("; ")}`);
  }
  const footer = "- the full transcript is unchanged in the session store; this block is a view, not a deletion.";
  const cutNote = `- (further summary lines omitted at the ${MAX_SUMMARY_CHARS}-char cap)`;

  const lines = [...head];
  let size = head.join("\n").length + 1 + footer.length;
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i] as string;
    const reserve = i < body.length - 1 ? 1 + cutNote.length : 0;
    if (size + 1 + line.length + reserve > MAX_SUMMARY_CHARS) {
      lines.push(cutNote);
      break;
    }
    lines.push(line);
    size += 1 + line.length;
  }
  lines.push(footer);
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

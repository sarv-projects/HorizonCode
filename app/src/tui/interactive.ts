/**
 * interactive.ts — the chat loop.
 *
 * This is the product: a small banner, then a chat bar. The human types in plain
 * language, the answer streams into the scrollback above, and the bar comes back.
 * Slash commands, approvals and Ctrl+C exist only to keep that conversation
 * flowing without ever leaving the keyboard.
 */

import * as readline from "node:readline";
import { appendFileSync, existsSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ContextUsage, RunExit, Runtime } from "../contracts";
import { loadCommands, resolveCommandForMessage } from "../core/commands";
import { getSkill } from "../core/skills";
import { maskSecrets } from "../core/compaction";
import { chainLine, convoStats, lastOfRole, osc52, renderExportHtml, renderExportJson, renderStats, type ChainStatus } from "../core/convo";
import { INSTRUCTION_KIND_LABEL, loadInstructionBlocks, peekLazyInstructions } from "../core/instructions";
import { unifiedDiff } from "../core/plan";
import type { SessionInfo } from "../core/session";
import type { PermissionMode } from "../core/permission-mode";
import { PERMISSION_MODES, describeMode, isPermissionMode, modeBadge, parsePermissionMode, permissionModeError } from "../core/permission-mode";
import { historyFilePath, stateRoot } from "../core/paths";
import * as toolsModule from "../tools";
import { resolveToolRoutingConfig } from "../tools/model-tool-routing";
import type { ApprovalUi } from "./approval";
import { printBanner, printGreeting, printRichBanner, shortenPath } from "./banner";
import { clockTime, createLive, liveEnabled, pickTip, readGitBranch, turnFooter, userBlock, type Live, type StatusInfo } from "./live";
import { PASTE_OFF, PASTE_ON, createPasteCollector, echoedRows, pasteLabel } from "./paste";
import { createRenderer, diffBlock, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, strip, terminalWidth, visibleWidth, wrapText, yellow } from "./style";

const PROMPT = "\u276f ";
const HISTORY_LIMIT = 500;

/** What the TUI needs from one staged change; a core `StagedChange` fits as-is. */
export interface StagedChangeView {
  rel: string;
  /** Present when the core hands its StagedChange over: the chat diffs it here. */
  before?: string | null;
  after?: string;
  /** Or a pre-rendered unified diff; when both are absent only the name shows. */
  diff?: string;
}

/** What the TUI needs from one checkpoint; a core checkpoint view fits as-is. */
export interface CheckpointView {
  /** 1-based newest-first number: what `/rewind <n>` takes. */
  n: number;
  /** Epoch milliseconds the checkpoint was recorded at. */
  at: number;
  /** Human label; empty = unlabelled (the list prints "(no label)"). */
  label: string;
  /** The journal entry ids the checkpoint covers (the list's change count). */
  changes: readonly string[];
  /** Transcript length at the checkpoint (what `/fork <n>` cuts at), when known. */
  messageIndex?: number;
}

/** Extras the core runtime may or may not expose yet; each one is optional. */
type RuntimeWithExtras = Runtime & {
  newSession?: () => unknown;
  setModel?: (model: string) => unknown;
  contextUsage?: () => ContextUsage | undefined;
  /** Plan-mode hooks. An older core simply does not offer them; nothing breaks. */
  setPlanMode?: (on: boolean) => unknown;
  planMode?: () => boolean;
  /** Permission-mode hooks (permission-mode.ts); optional like the plan ones. */
  permissionMode?: () => PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => unknown;
  stagedChanges?: () => ReadonlyArray<StagedChangeView>;
  applyPlan?: () => Promise<string>;
  discardPlan?: () => number;
  /** Rewind hooks. An older core simply does not offer them; nothing breaks. */
  checkpoints?: () => ReadonlyArray<CheckpointView>;
  rewindTo?: (n: number) => Promise<string>;
  /** Session fork hooks (optional like the rest). */
  forkSession?: (at?: number) => Promise<SessionInfo>;
  switchSession?: (sessionId: string) => unknown;
  sessions?: () => ReadonlyArray<SessionInfo>;
  /** Conversation verbs (T-12), optional like the rest. */
  history?: () => ChatMsg[];
  renameSession?: (title: string) => string;
  retryLast?: () => string | undefined;
  sessionTitle?: () => string;
  receiptChain?: () => Promise<ChainStatus>;
};

export interface InteractiveOptions {
  runtime: Runtime;
  workspace: string;
  version: string;
  /** shared approval hand-off (main.ts registers it with the core runtime) */
  ui: ApprovalUi;
  /** a message typed on the command line, sent as the first turn */
  initialMessage?: string;
}

/* ----------------------------- history file ----------------------------- */

const HISTORY_FILE_MODE = 0o600;
const isUnix = process.platform !== "win32";

/**
 * The history file is owner-only (docs/03 D12): post-create chmod, exact mode
 * regardless of umask, best-effort (a missing file is simply a first run) and a
 * no-op on non-Unix. Exported with the two history writers below so the mode
 * contract is testable without driving the interactive loop.
 */
function setHistoryOwnerOnly(file: string): void {
  if (!isUnix) return;
  try {
    chmodSync(file, HISTORY_FILE_MODE);
  } catch {
    /* no history file yet: nothing to tighten */
  }
}

/** Exported for tests; `runInteractive` wires it to the live readline instance. */
export function loadHistory(file: string, rl: readline.Interface): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* history is a convenience, never a reason to fail */
  }
  try {
    const recent = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-HISTORY_LIMIT);
    (rl as unknown as { history: string[] }).history = recent.reverse();
  } catch {
    /* first run: no history yet */
  }
  // Tightens a pre-existing loose-mode file on every open (docs/03 D12).
  setHistoryOwnerOnly(file);
}

/** Exported for tests; `runInteractive` wires it to the live readline instance. */
export function rememberHistory(file: string, text: string): void {
  try {
    appendFileSync(file, text.replace(/\s+/g, " ") + "\n");
    // Applied after the append: covers a fresh file and tightens a loose one.
    setHistoryOwnerOnly(file);
    if (statSync(file).size > 512 * 1024) {
      const kept = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-HISTORY_LIMIT)
        .join("\n");
      writeFileSync(file, kept + "\n");
      setHistoryOwnerOnly(file);
    }
  } catch {
    /* history is a convenience, never a reason to fail */
  }
}

/* ------------------------------ local text ------------------------------ */

function printWrapped(r: Renderer, text: string, style: (s: string) => string = (s) => s): void {
  const plain = strip(text);
  if (visibleWidth(plain) <= terminalWidth()) {
    r.line(text);
    return;
  }
  for (const part of wrapText(plain, terminalWidth())) r.line(style(part));
}

function printHelp(r: Renderer, workspace?: string): void {
  const rows: Array<[string, string]> = [
    ["/help", "this list"],
    ["/new", "start a fresh session"],
    ["/model [name]", "show or switch the model"],
    ["/files", "tools the assistant can use"],
    ["/context", "what the next request will carry"],
    ["/plan [on|off]", "toggle plan mode (writes are staged)"],
    ["/mode [name]", "show or set the permission mode: default, plan, accept-edits, read-only"],
    ["/changes", "review staged changes and diffs"],
    ["/apply", "write the staged changes"],
    ["/discard", "drop the staged changes"],
    ["/fork [n]", "branch this chat into a new session (n = checkpoint number, else everything so far)"],
    ["/sessions", "recent sessions with fork lineage (resume a fork with hzcode --resume <id>)"],
    ["/rename <title>", "retitle this session"],
    ["/retry", "drop the last reply and ask the same question again"],
    ["/stats", "message, tool call and token counts for this chat"],
    ["/export [json|html]", "write the chat to .hz/exports (html shows the receipt chain status)"],
    ["/copy", "copy the last answer to the clipboard (terminal OSC 52)"],
    ["/rewind [n]", "list checkpoints; n restores the files changed since one"],
    ["/memory", "which instruction files (AGENTS.md, CLAUDE.md, ...) are loaded (alias /instructions)"],
    ["/init", "draft an AGENTS.md for this repo (staged; you review it, then /apply)"],
    ["/exit", "leave (Ctrl+D also works)"],
  ];
  const width = rows.reduce((max, [cmd]) => Math.max(max, cmd.length), 0) + 2;
  r.line(dim("Just type what you want in plain language \u2014 no flags needed."));
  r.line("");
  for (const [cmd, desc] of rows) r.line("  " + bold(cmd.padEnd(width)) + dim(desc));
  r.line("");
  if (workspace !== undefined) {
    let listing: ReturnType<typeof loadCommands> = { commands: [], shadowed: [] };
    try {
      listing = loadCommands(workspace);
    } catch {
      /* a bad commands dir never breaks /help */
    }
    if (listing.commands.length > 0) {
      r.line("");
      r.line(dim("Custom commands (prompt templates from .hz/commands):"));
      const cw = listing.commands.reduce((max, c) => Math.max(max, c.name.length + 1), 0) + 2;
      for (const c of listing.commands) r.line("  " + bold(("/" + c.name).padEnd(cw)) + dim(c.description));
    }
    if (listing.shadowed.length > 0) {
      r.line(dim(`  ignored (a builtin owns the name): ${listing.shadowed.map((n) => "/" + n).join(", ")}`));
    }
  }
  printWrapped(r, "  Ctrl+C  stop the current answer (again to leave)   Ctrl+D  leave   \u2191/\u2193  earlier messages", dim);
}

/**
 * The /files report. Every registered tool lands in exactly one bucket, so the
 * counts add up to the registry size: visible to the model now, deferred (the
 * model unlocks it through tool_search), or hidden by the model->tool routing
 * table for the active model/provider.
 */
export function describeTools(runtime: Runtime): { visible: string[]; deferred: string[]; routed: string[]; total: number } | undefined {
  const all = (toolsModule as { tools?: ReadonlyArray<{ name?: string }> }).tools;
  const exposureOf = (toolsModule as { exposureOf?: (t: unknown) => string }).exposureOf;
  const isDiscovered = (toolsModule as { isDiscovered?: (id: string | undefined, name: string) => boolean }).isDiscovered;
  if (!Array.isArray(all) || typeof exposureOf !== "function") return undefined;
  const routing = resolveToolRoutingConfig({ model: runtime.model, provider: runtime.providerName });
  const visible: string[] = [];
  const deferred: string[] = [];
  const routed: string[] = [];
  for (const tool of all) {
    const name = tool?.name;
    if (typeof name !== "string" || name === "") continue;
    const exposure = exposureOf(tool);
    if (!routing.isToolEnabled(name)) routed.push(name);
    else if (exposure === "deferred" && !(isDiscovered?.(runtime.sessionId, name) ?? false)) deferred.push(name);
    else if (exposure === "hidden" || exposure === "code_mode_only") continue;
    else visible.push(name);
  }
  return { visible, deferred, routed, total: visible.length + deferred.length + routed.length };
}

/**
 * One line naming how a turn ended, for every turn alike (plan mode too). A
 * clean turn_end stays silent; anything else says why the run stopped.
 */
export function exitLine(exit: RunExit | undefined): string | undefined {
  if (exit === undefined || (exit.terminal === "succeeded" && (exit.detail === undefined || exit.detail === "turn_end"))) {
    return undefined;
  }
  return `turn ended: ${exit.terminal}${exit.detail !== undefined ? ` (${exit.detail})` : ""}`;
}

function showTools(r: Renderer, runtime: Runtime): void {
  let report: ReturnType<typeof describeTools>;
  try {
    report = describeTools(runtime);
  } catch {
    report = undefined;
  }
  if (report === undefined || report.total === 0) {
    r.notice("no tools are registered in this build yet");
    return;
  }
  r.notice(`tools (${report.total} registered): ${report.visible.length} available now: ${report.visible.join(", ")}`);
  if (report.deferred.length > 0) {
    r.notice(`  ${report.deferred.length} deferred (the assistant finds them with tool_search): ${report.deferred.join(", ")}`);
  }
  if (report.routed.length > 0) {
    r.notice(`  ${report.routed.length} hidden for ${runtime.model} (model tool routing): ${report.routed.join(", ")}`);
  }
}

/* ------------------------------ plan mode ------------------------------ */

/** How many lines of each staged diff /changes shows before the cap marker. */
const CHANGES_DIFF_LINES = 20;

/** The chat bar, with the PLAN badge ahead of the prompt when plan mode is on. */
export function planPrompt(planOn: boolean, mode: PermissionMode = "default"): string {
  const badge = planOn ? "PLAN" : modeBadge(mode);
  return (badge !== "" ? bold(yellow(badge)) + " " : "") + bold(cyan(PROMPT));
}

/** The runtime's permission mode, or "default" when the core does not say. */
export function readPermissionMode(runtime: Runtime): PermissionMode {
  const read = (runtime as RuntimeWithExtras).permissionMode;
  if (typeof read !== "function") return "default";
  try {
    const mode = read.call(runtime);
    return isPermissionMode(mode) ? mode : "default";
  } catch {
    return "default";
  }
}

/**
 * /mode [name]: show or set the permission mode. Session-only (nothing is
 * written to config) and never a bypass: yolo/bypass names get the refusal.
 * Returns the mode now in force so the caller can redraw the badge.
 */
export function runModeCommand(arg: string, runtime: Runtime, renderer: Renderer): PermissionMode {
  const extras = runtime as RuntimeWithExtras;
  const current = readPermissionMode(runtime);
  if (arg === "") {
    renderer.notice(`permission mode: ${describeMode(current)}. Set with /mode ${PERMISSION_MODES.join("|")}`);
    return current;
  }
  const next = parsePermissionMode(arg);
  if (next === undefined) {
    renderer.notice(permissionModeError(arg));
    return current;
  }
  if (typeof extras.setPermissionMode !== "function") {
    notSupported(renderer, "setPermissionMode", "permission-mode");
    return current;
  }
  try {
    extras.setPermissionMode.call(runtime, next);
  } catch (err) {
    renderer.notice(`could not change permission mode: ${errorMessage(err)}`);
    return readPermissionMode(runtime);
  }
  const now = readPermissionMode(runtime);
  renderer.notice(`permission mode now ${describeMode(now)}`);
  return now;
}

/** The runtime's current plan-mode flag, or false when it does not say. */
function readPlanMode(runtime: Runtime): boolean {
  const read = (runtime as RuntimeWithExtras).planMode;
  if (typeof read !== "function") return false;
  try {
    return Boolean(read.call(runtime));
  } catch {
    return false;
  }
}

/** One typed refusal line for a command whose runtime hook is absent. */
function notSupported(renderer: Renderer, method: string, hook = "plan-mode"): void {
  renderer.notice(`not supported by this runtime: ${method} \u2014 this core build does not expose the ${hook} hook`);
}

/** State the plan commands share with runInteractive: the badge follows it. */
export interface PlanCommandState {
  on: boolean;
}

/**
 * The four plan-mode slash commands, factored out of runInteractive so tests
 * can drive them without a TTY (the same unit-level pattern as the approval
 * handler). Returns false when `name` is not a plan command, so the caller's
 * command table decides the unknown-command answer. Every runtime method is
 * optional: an absent hook prints one typed "not supported" line — never a
 * crash, and never a wrong answer (a toggle that cannot reach the core does
 * not flip the badge).
 */
export async function runPlanCommand(
  name: string,
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
  state: PlanCommandState,
): Promise<boolean> {
  switch (name) {
    case "plan":
      togglePlanMode(arg, runtime, renderer, state);
      return true;
    case "changes":
      listStagedChanges(runtime, renderer);
      return true;
    case "apply":
      await applyStagedPlan(runtime, renderer);
      return true;
    case "discard":
      discardStagedPlan(runtime, renderer);
      return true;
    default:
      return false;
  }
}

function togglePlanMode(arg: string, runtime: Runtime, renderer: Renderer, state: PlanCommandState): void {
  const explicit = arg === "on" ? true : arg === "off" ? false : undefined;
  if (arg !== "" && explicit === undefined) {
    renderer.notice("usage: /plan [on|off] \u2014 bare /plan toggles plan mode");
    return;
  }
  const extras = runtime as RuntimeWithExtras;
  if (typeof extras.setPlanMode !== "function") {
    notSupported(renderer, "setPlanMode");
    return;
  }
  const next = explicit ?? !state.on;
  try {
    extras.setPlanMode.call(runtime, next);
  } catch (err) {
    renderer.notice(`could not change plan mode: ${errorMessage(err)}`);
    return;
  }
  // A runtime that reports its own mode is the source of truth; one that
  // cannot keeps the requested value locally (so the badge still follows).
  state.on = typeof extras.planMode === "function" ? readPlanMode(runtime) : next;
  renderer.notice(
    state.on
      ? "plan mode on \u2014 writes and edits are staged for review; /changes shows them, /apply writes them, /discard drops them"
      : "plan mode off \u2014 new writes apply directly; anything already staged stays until /apply or /discard",
  );
}

/** The diff /changes shows for one staged entry: precomputed, derived, or none. */
function stagedDiff(change: StagedChangeView): string {
  if (typeof change.diff === "string" && change.diff !== "") return change.diff;
  if (typeof change.after !== "string") return "";
  const before = typeof change.before === "string" ? change.before : null;
  return unifiedDiff(before, change.after, typeof change.rel === "string" ? change.rel : "change", CHANGES_DIFF_LINES);
}

function listStagedChanges(runtime: Runtime, renderer: Renderer): void {
  const staged = (runtime as RuntimeWithExtras).stagedChanges;
  if (typeof staged !== "function") {
    notSupported(renderer, "stagedChanges");
    return;
  }
  let list: ReadonlyArray<StagedChangeView>;
  try {
    const raw = staged.call(runtime) as ReadonlyArray<StagedChangeView> | undefined;
    list = Array.isArray(raw) ? raw : [];
  } catch (err) {
    renderer.notice(`could not list staged changes: ${errorMessage(err)}`);
    return;
  }
  if (list.length === 0) {
    renderer.notice("no staged changes \u2014 /plan on stages writes and edits for review");
    return;
  }
  renderer.notice(`staged changes (${list.length}):`);
  for (const change of list) {
    const rel = sanitizeText(change?.rel ?? "") || "(unnamed)";
    renderer.line("  " + bold(rel));
    const diff = stagedDiff(change ?? { rel: "(unnamed)" });
    if (diff !== "") renderer.write(diffBlock(diff) + "\n");
  }
}

async function applyStagedPlan(runtime: Runtime, renderer: Renderer): Promise<void> {
  const apply = (runtime as RuntimeWithExtras).applyPlan;
  if (typeof apply !== "function") {
    notSupported(renderer, "applyPlan");
    return;
  }
  try {
    const summary = await Promise.resolve(apply.call(runtime));
    const line = typeof summary === "string" && summary.trim() !== "" ? summary.trim() : "the staged plan is applied";
    renderer.notice(`applied: ${line}`);
  } catch (err) {
    renderer.notice(`could not apply the staged plan: ${errorMessage(err)}`);
  }
}

function discardStagedPlan(runtime: Runtime, renderer: Renderer): void {
  const discard = (runtime as RuntimeWithExtras).discardPlan;
  if (typeof discard !== "function") {
    notSupported(renderer, "discardPlan");
    return;
  }
  try {
    const raw = discard.call(runtime);
    const count = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    renderer.notice(
      count === 0 ? "nothing to discard \u2014 no staged changes" : `discarded ${count} staged change${count === 1 ? "" : "s"}`,
    );
  } catch (err) {
    renderer.notice(`could not discard the staged plan: ${errorMessage(err)}`);
  }
}

/* -------------------------------- rewind -------------------------------- */

/** How many checkpoints bare /rewind lists (the newest page). */
const REWIND_LIST_LIMIT = 10;

/** The list line's time stamp: local `YYYY-MM-DD HH:MM` (the human's clock). */
function checkpointTime(at: unknown): string {
  const when = new Date(typeof at === "number" && Number.isFinite(at) ? at : Number.NaN);
  if (Number.isNaN(when.getTime())) return "unknown time";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** One `n) time \u2014 label, N change(s)` line of the checkpoint list. */
function checkpointListLine(view: CheckpointView): string {
  const n = typeof view?.n === "number" && Number.isInteger(view.n) && view.n > 0 ? view.n : 0;
  const rawLabel = typeof view?.label === "string" ? view.label : "";
  const label = sanitizeText(rawLabel).replace(/\s+/g, " ").trim() || "(no label)";
  const count = Array.isArray(view?.changes) ? view.changes.length : 0;
  return (
    `  ${bold(`${n})`)} ${checkpointTime(view?.at)} \u2014 ${label}, ${count} change${count === 1 ? "" : "s"}`
  );
}

/** The runtime's checkpoints, or a typed absence; never throws into the chat. */
function listCheckpoints(runtime: Runtime, renderer: Renderer): void {
  const list = (runtime as RuntimeWithExtras).checkpoints;
  if (typeof list !== "function") {
    notSupported(renderer, "checkpoints", "rewind");
    return;
  }
  let views: ReadonlyArray<CheckpointView>;
  try {
    const raw = list.call(runtime) as ReadonlyArray<CheckpointView> | undefined;
    views = Array.isArray(raw) ? raw : [];
  } catch (err) {
    renderer.notice(`could not list checkpoints: ${errorMessage(err)}`);
    return;
  }
  if (views.length === 0) {
    renderer.notice("no checkpoints yet \u2014 a checkpoint is recorded after each turn");
    return;
  }
  renderer.notice(`checkpoints (newest first, ${views.length} total):`);
  for (const view of views.slice(0, REWIND_LIST_LIMIT)) renderer.line(checkpointListLine(view));
  if (views.length > REWIND_LIST_LIMIT) {
    renderer.notice(`... ${views.length - REWIND_LIST_LIMIT} older checkpoint(s) \u2014 /rewind <n> takes the number from this list`);
  }
}

/** One /sessions row: id, title, and the fork lineage when there is one. */
export function describeSession(s: SessionInfo, currentId?: string): string {
  const mark = s.id === currentId ? "* " : "  ";
  const lineage =
    s.forkedFrom !== undefined
      ? ` (fork of ${s.forkedFrom.sessionId} at message ${s.forkedFrom.messageIndex})`
      : "";
  return `${mark}${s.id}  ${s.title}${lineage}`;
}

/**
 * /fork [n] and /sessions. `/fork` copies the transcript into a new session
 * and moves this chat onto it (the original stays as it was and can be resumed
 * by id); `/fork n` cuts at checkpoint n's message index. Returns false when
 * `name` is not one of the two.
 */
export async function runForkCommand(
  name: string,
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
): Promise<boolean> {
  const rt = runtime as RuntimeWithExtras;
  if (name === "sessions") {
    if (typeof rt.sessions !== "function") {
      notSupported(renderer, "sessions", "sessions");
      return true;
    }
    for (const s of rt.sessions()) renderer.line(describeSession(s, runtime.sessionId));
    return true;
  }
  if (name !== "fork") return false;
  if (typeof rt.forkSession !== "function" || typeof rt.switchSession !== "function") {
    notSupported(renderer, "forkSession", "fork");
    return true;
  }
  let at: number | undefined;
  const text = arg.trim();
  if (text !== "") {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) {
      renderer.notice("usage: /fork [n]: n is a checkpoint number from /rewind");
      return true;
    }
    const cp = typeof rt.checkpoints === "function" ? rt.checkpoints().find((c) => c.n === n) : undefined;
    const idx = cp?.messageIndex;
    if (typeof idx !== "number") {
      renderer.notice(`no checkpoint ${n} to fork at; /rewind lists them`);
      return true;
    }
    at = idx;
  }
  try {
    const parentId = runtime.sessionId;
    const child = await rt.forkSession(at);
    rt.switchSession(child.id);
    renderer.notice(
      `forked ${parentId} -> ${child.id} (${child.forkedFrom?.messageIndex ?? 0} message(s) copied); the original is untouched`,
    );
  } catch (err) {
    renderer.notice(`could not fork: ${errorMessage(err)}`);
  }
  return true;
}

/**
 * T-12 conversation verbs: /rename, /stats, /export, /copy (and the history
 * half of /retry lives in runtime.retryLast, called by the chat loop). Returns
 * false when `name` is not one of them. Every hook is optional; never throws.
 */
export async function runConvoCommand(
  name: string,
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
  workspace: string,
  write: (text: string) => void = (t) => void process.stdout.write(t),
): Promise<boolean> {
  const rt = runtime as RuntimeWithExtras;
  const history = (): ChatMsg[] | undefined => {
    if (typeof rt.history !== "function") {
      notSupported(renderer, "history", name);
      return undefined;
    }
    return rt.history();
  };
  try {
    switch (name) {
      case "rename": {
        if (arg.trim() === "") renderer.notice("usage: /rename <title>");
        else if (typeof rt.renameSession !== "function") notSupported(renderer, "renameSession", name);
        else renderer.notice(`session renamed: ${rt.renameSession(arg)}`);
        return true;
      }
      case "stats": {
        const h = history();
        if (h) renderer.notice(renderStats(convoStats(h)));
        return true;
      }
      case "copy": {
        const h = history();
        if (!h) return true;
        const text = lastOfRole(h, "assistant");
        if (text === undefined) renderer.notice("nothing to copy yet");
        else {
          write(osc52(text));
          renderer.notice(`copied ${text.length} character(s) via the terminal clipboard (OSC 52; needs terminal support)`);
        }
        return true;
      }
      case "export": {
        const format = arg.trim().toLowerCase() || "json";
        if (format !== "json" && format !== "html") {
          renderer.notice("usage: /export [json|html]");
          return true;
        }
        const h = history();
        if (!h) return true;
        let chain: ChainStatus | undefined;
        try {
          chain = typeof rt.receiptChain === "function" ? await rt.receiptChain() : undefined;
        } catch {
          chain = undefined;
        }
        const meta = {
          sessionId: runtime.sessionId,
          title: rt.sessionTitle?.() ?? "chat",
          model: runtime.model,
          exportedAt: new Date().toISOString(),
          chain,
        };
        const dir = path.join(stateRoot(workspace), "exports");
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${runtime.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.${format}`);
        // The export leaves the guarded state tree as a shareable file: mask secret-like values.
        writeFileSync(file, maskSecrets(format === "json" ? renderExportJson(h, meta) : renderExportHtml(h, meta)), { mode: 0o600 });
        renderer.notice(`exported ${h.length} message(s) to ${shortenPath(file)} (${chainLine(chain)})`);
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    renderer.notice(`/${name} failed: ${errorMessage(err)}`);
    return true;
  }
}

/**
 * The /rewind slash command: bare `/rewind` lists the newest checkpoints,
 * `/rewind <n>` asks the runtime to rewind to one. Follows the plan-mode
 * slice's contract exactly: every runtime method is optional, an absent hook
 * prints one typed "not supported" line, and a throwing hook is reported
 * rather than fatal. Returns false when `name` is not the rewind command, so
 * the caller's command table decides the unknown-command answer.
 */
export async function runRewindCommand(
  name: string,
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
): Promise<boolean> {
  if (name !== "rewind") return false;
  if (arg === "") {
    listCheckpoints(runtime, renderer);
    return true;
  }
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) {
    renderer.notice("usage: /rewind <n> \u2014 bare /rewind lists the newest checkpoints");
    return true;
  }
  const rewind = (runtime as RuntimeWithExtras).rewindTo;
  if (typeof rewind !== "function") {
    notSupported(renderer, "rewindTo", "rewind");
    return true;
  }
  try {
    const summary = await Promise.resolve(rewind.call(runtime, n));
    const line = typeof summary === "string" && summary.trim() !== "" ? summary.trim() : `checkpoint ${n}`;
    renderer.notice(`rewound: ${line}`);
  } catch (err) {
    renderer.notice(`could not rewind: ${errorMessage(err)}`);
  }
  return true;
}

/* ------------------------- /memory and /init ------------------------- */

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The /memory (alias /instructions) report: every project instruction file the
 * next request will carry, in precedence order (least to most specific, later
 * wins), with sizes and what was truncated, skipped or left unapplied.
 */
export function runMemoryCommand(
  name: string,
  workspace: string,
  renderer: Renderer,
  opts: { home?: string; sessionId?: string } = {},
): boolean {
  if (name !== "memory" && name !== "instructions") return false;
  const { blocks, report } = loadInstructionBlocks(workspace, opts.home === undefined ? {} : { home: opts.home });
  const lazyState = opts.sessionId === undefined ? undefined : peekLazyInstructions(workspace, opts.sessionId);
  if (blocks.length === 0 && report.skipped.length === 0 && report.scoped.length === 0 && (lazyState?.all().length ?? 0) === 0) {
    renderer.notice("no project instruction files found: /init drafts an AGENTS.md");
    return true;
  }
  renderer.notice(
    `project instructions: ${report.files} file(s), ${kb(report.totalBytes)} of 128 KB (least to most specific; later wins; your messages win over all)`,
  );
  for (const block of blocks) {
    const size = kb(Buffer.byteLength(block.text, "utf8"));
    renderer.notice(
      `  ${block.rel}  ${INSTRUCTION_KIND_LABEL[block.kind]}  ${size}${block.truncated ? "  TRUNCATED at the 32 KB cap" : ""}`,
    );
  }
  for (const skipped of report.skipped) renderer.notice(`  skipped: ${skipped}`);
  for (const scoped of report.scoped) renderer.notice(`  not applied: ${scoped}`);
  if (report.totalCapped) renderer.notice("  the 128 KB total cap stopped further files");
  const lazy = lazyState;
  const loadedLazy = lazy?.all() ?? [];
  if (loadedLazy.length > 0) {
    renderer.notice(`nested instructions loaded this session: ${loadedLazy.length}`);
    for (const block of loadedLazy) {
      renderer.notice(`  ${block.rel}  ${INSTRUCTION_KIND_LABEL[block.kind]}  ${kb(Buffer.byteLength(block.text, "utf8"))}  (lazy)`);
    }
  }
  for (const rel of lazy?.skippedForBudget() ?? []) renderer.notice(`  nested, not loaded (lazy budget used up): ${rel}`);
  renderer.notice("nested AGENTS.md/CLAUDE.md below the working directory load after a tool successfully reads or edits a file there");
  return true;
}

/**
 * The /init turn prompt. The model inspects the repository with read-only tools
 * only, then proposes AGENTS.md through the ordinary `write` (or `edit`) tool,
 * which goes through the guard and the user's approval like any other write:
 * /init itself never touches the disk.
 */
export function initPrompt(workspace: string): string {
  const exists = existsSync(path.join(workspace, "AGENTS.md"));
  return [
    exists
      ? "An AGENTS.md already exists in this repository. Review it against the repository and propose targeted improvements with the edit tool; do not replace it wholesale."
      : "Create an AGENTS.md for this repository.",
    "First inspect the repository using ONLY read-only tools (read, glob, grep, repo_map; no shell commands that modify anything): the manifest and lockfile, the build, test, lint and typecheck commands as actually defined, the directory layout, the code style and naming conventions you can observe, and any README or CONTRIBUTING guidance.",
    "Then write a concise AGENTS.md (aim for under 80 lines) with: what the project is, exact commands to build, test and lint, the layout in a few lines, conventions and pitfalls specific to this repo, and what to never touch. Only state facts you verified in the files; leave out generic advice. Do not include secrets.",
    exists ? "" : "Write it with the write tool at AGENTS.md in the repository root. The write is reviewed and approved by the user before it lands; do not try to work around that.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * /init: runs the draft as an ordinary turn, but with plan mode on when the
 * runtime offers it, so the AGENTS.md write is STAGED rather than landed: the
 * user reviews the diff (/changes) and /apply performs the write through the
 * normal guarded `write` tool (guard check, approval prompt, ledger, journal).
 * /init itself never touches the disk. Plan mode returns to its prior state
 * afterwards; the staged draft stays. Returns false when `name` is not /init.
 */
export async function runInitCommand(
  name: string,
  workspace: string,
  runtime: Runtime,
  renderer: Renderer,
  send: (prompt: string) => Promise<void>,
): Promise<boolean> {
  if (name !== "init") return false;
  const extras = runtime as RuntimeWithExtras;
  const wasOn = readPlanMode(runtime);
  const canStage = typeof extras.setPlanMode === "function";
  if (canStage && !wasOn) extras.setPlanMode?.call(runtime, true);
  if (!canStage) renderer.notice("this runtime has no plan mode: the AGENTS.md write goes through the normal guard and approval prompt");
  else renderer.notice("drafting AGENTS.md (read-only inspection; the write is staged for your review)");
  try {
    await send(initPrompt(workspace));
  } finally {
    if (canStage && !wasOn) extras.setPlanMode?.call(runtime, false);
  }
  try {
    const staged = typeof extras.stagedChanges === "function" ? extras.stagedChanges.call(runtime) : [];
    if (staged.some((change) => change.rel === "AGENTS.md")) {
      renderer.notice("AGENTS.md draft staged: /changes to review the diff, /apply to write it (through the normal guard), /discard to drop it");
    }
  } catch {
    /* the notice is a convenience */
  }
  return true;
}

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const { workspace, ui } = opts;
  let runtime: Runtime = opts.runtime;
  // Plan mode is a session posture: the badge reflects the runtime's flag, and
  // /plan updates it through the optional hook when the core exposes one.
  const planState: PlanCommandState = { on: readPlanMode(runtime) };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });

  let busy = false;
  let exiting = false;
  let abortRequested = false;
  let answerWaiter: ((line: string) => void) | null = null;
  let typedGuardArmed = false;
  const queued: string[] = [];
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  let live: Live | undefined;
  let contextPercent: number | undefined;

  const renderer: Renderer = createRenderer({
    wrap: true,
    rich: liveEnabled(),
    beforeWrite: () => {
      // The animated bottom region never ends up in the transcript.
      live?.erase();
      // While an answer streams, anything typed into the chat bar stays on its own
      // line instead of being overwritten by the next chunk.
      if (!busy) {
        typedGuardArmed = false;
        return false;
      }
      const typed = String((rl as unknown as { line?: string }).line ?? "").length > 0;
      if (!typed) {
        typedGuardArmed = false;
        return false;
      }
      if (typedGuardArmed) return false;
      typedGuardArmed = true;
      process.stdout.write("\n");
      return true;
    },
  });

  // Esc cancels only where readline's raw keypress events are available.
  const canEsc = Boolean(process.stdin.isTTY) && typeof process.stdin.setRawMode === "function";
  let branchCache: { at: number; value: string | undefined } = { at: 0, value: undefined };
  const statusInfo = (): StatusInfo => {
    if (Date.now() - branchCache.at > 2000) branchCache = { at: Date.now(), value: readGitBranch(workspace) };
    return {
      badge: planState.on ? "PLAN" : modeBadge(readPermissionMode(runtime)),
      model: runtime.model,
      provider: runtime.providerName,
      contextPercent,
      path: shortenPath(workspace),
      branch: branchCache.value,
    };
  };
  live = createLive({
    enabled: liveEnabled(),
    write: (chunk) => void process.stdout.write(chunk),
    status: statusInfo,
    atLineStart: () => renderer.atLineStart(),
    typed: () => String((rl as unknown as { line?: string }).line ?? "").length > 0,
    esc: canEsc,
    paused: () => answerWaiter !== null,
    group: (tick, width) => renderer.liveLines?.(tick, width) ?? [],
  });
  const liveOn = live.enabled;

  // Wire the guard to this session: one line of the same chat bar is the answer.
  ui.renderer = renderer;
  ui.runtime = runtime;
  ui.ask = (question: string) =>
    new Promise<string>((resolve) => {
      answerWaiter = resolve;
      try {
        rl.setPrompt(question);
        rl.prompt();
      } catch {
        answerWaiter = null;
        resolve("");
      }
    });

  const historyFile = historyFilePath(workspace);
  loadHistory(historyFile, rl);

  const out = (chunk: string): void => renderer.write(chunk);
  const bannerInfo = { version: opts.version, model: runtime.model, provider: runtime.providerName, workspace, kernel: runtime.kernelMode };
  if (liveOn) printRichBanner(bannerInfo, { out, tip: pickTip() });
  else printBanner(bannerInfo, { out });
  printGreeting({ out });

  const finish = (code: number): void => {
    if (exiting) return;
    exiting = true;
    live?.dispose();
    try {
      if (process.stdout.isTTY && process.stdin.isTTY) process.stdout.write(PASTE_OFF);
    } catch {
      /* terminal went away */
    }
    try {
      runtime.abort();
    } catch {
      /* nothing in flight */
    }
    try {
      rl.close();
    } catch {
      /* already closed */
    }
    try {
      if (process.stdout.isTTY) process.stdout.write(busy ? "\n" : "\r\u001b[K\n");
    } catch {
      /* terminal went away */
    }
    resolveDone(code);
  };

  const showPrompt = (blank = false): void => {
    if (exiting) return;
    typedGuardArmed = false;
    if (blank) renderer.write("\n");
    try {
      rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
      if (renderer.atLineStart()) live?.showIdle();
      rl.prompt();
    } catch {
      /* terminal went away */
    }
  };

  const sendTurn = async (text: string): Promise<void> => {
    busy = true;
    abortRequested = false;
    typedGuardArmed = false;
    try {
      rl.setPrompt("");
    } catch {
      /* ignore */
    }
    renderer.ensureLineStart();
    live?.beginTurn();
    try {
      const result = await runtime.send(text, {
        onEvent: (ev) => {
          if (ev && typeof ev === "object") {
            if (ev.type === "tool.card") {
              if (ev.status === "running") live?.toolStart(String(ev.name), ev.args, String(ev.callId));
              else live?.toolEnd(String(ev.callId));
            } else if (ev.type === "context.usage") {
              if (ev.window > 0) contextPercent = (ev.estimatedInput / ev.window) * 100;
              live?.noteUsage(ev.estimatedInput);
            }
          }
          renderer.handle(ev);
        },
      });
      const line = exitLine(result?.exit);
      if (line !== undefined) {
        renderer.ensureLineStart();
        renderer.notice(line);
      }
    } catch (err) {
      renderer.error(`request failed: ${errorMessage(err)}`);
    } finally {
      busy = false;
      const stats = live?.endTurn();
      renderer.ensureLineStart();
      if (stats && liveOn) {
        renderer.write(
          turnFooter({ ms: stats.ms, tools: stats.tools, inputTokens: stats.inputTokens, time: clockTime(), width: terminalWidth() - 1 }) + "\n",
        );
      }
    }
  };

  const echoUser = (text: string): void => {
    if (liveOn) {
      renderer.write(userBlock(sanitizeText(text), terminalWidth(), clockTime()).join("\n") + "\n");
      return;
    }
    renderer.write(planPrompt(planState.on, readPermissionMode(runtime)) + sanitizeText(text) + "\n");
  };

  const drainQueue = async (): Promise<void> => {
    while (!exiting && queued.length > 0) {
      const next = queued.shift() as string;
      echoUser(next);
      await sendTurn(next);
    }
  };

  const tryNewSession = async (): Promise<Runtime | null> => {
    const candidate = (runtime as RuntimeWithExtras).newSession;
    if (typeof candidate !== "function") {
      renderer.notice("this session cannot be reset in place \u2014 leave with Ctrl+D and run hzcode again to start fresh");
      renderer.notice(`current session: ${runtime.sessionId}`);
      return null;
    }
    try {
      const next = (await Promise.resolve(candidate.call(runtime))) as Runtime | undefined;
      if (next && typeof next.send === "function") {
        renderer.notice(`new session: ${next.sessionId}`);
        printGreeting({ out });
        return next;
      }
      renderer.notice("the runtime did not hand back a new session");
      return null;
    } catch (err) {
      renderer.notice(`could not start a new session: ${errorMessage(err)}`);
      return null;
    }
  };

  const showOrSetModel = async (arg: string): Promise<void> => {
    if (arg === "") {
      renderer.notice(`model ${runtime.model} \u00b7 provider ${runtime.providerName}`);
      return;
    }
    const setModel = (runtime as RuntimeWithExtras).setModel;
    if (typeof setModel !== "function") {
      renderer.notice(`this session stays on ${runtime.model} \u2014 start with hzcode --model ${arg} to use another model`);
      return;
    }
    try {
      const applied = (await Promise.resolve(setModel.call(runtime, arg))) as unknown;
      renderer.notice(`model \u2192 ${typeof applied === "string" && applied !== "" ? applied : arg}`);
    } catch (err) {
      renderer.notice(`could not switch model: ${errorMessage(err)}`);
    }
  };

  const showContext = (): void => {
    const usage = (runtime as RuntimeWithExtras).contextUsage?.();
    if (!usage) {
      renderer.notice("no context snapshot yet \u2014 send a message first, then ask again");
      return;
    }
    const percent = usage.window > 0 ? Math.round((usage.estimatedInput / usage.window) * 100) : 0;
    renderer.notice(
      `context \u00b7 model ${usage.model} \u00b7 window ${usage.window} tok \u00b7 estimated input ${usage.estimatedInput} tok (${percent}%) \u00b7 output cap ${usage.maxOutput} tok \u00b7 ${usage.messages}/${usage.historyLimit} messages in view`,
    );
  };

  /** Send text as if typed: queue it while an answer streams, else run it now. */
  const sendUserText = async (text: string): Promise<void> => {
    if (busy) {
      queued.push(text);
      renderer.notice(`queued \u2014 it goes next (${queued.length} waiting)`);
      return;
    }
    await sendTurn(text);
    await drainQueue();
  };

  const runSlash = async (text: string): Promise<void> => {
    const body = text.slice(1).trim();
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const arg = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();

    switch (name) {
      case "help":
      case "?":
        printHelp(renderer, workspace);
        break;
      case "exit":
      case "quit":
        finish(0);
        return;
      case "new": {
        const next = await tryNewSession();
        if (next) {
          runtime = next;
          ui.runtime = next;
          // A fresh session starts with whatever posture its runtime reports
          // (staged changes are per-session; nothing here carries over).
          planState.on = readPlanMode(next);
        }
        break;
      }
      case "model":
        await showOrSetModel(arg);
        break;
      case "files":
        showTools(renderer, runtime);
        break;
      case "context":
        showContext();
        break;
      case "mode":
        runModeCommand(arg, runtime, renderer);
        // /mode plan flips the runtime's plan flag: keep the badge in step.
        planState.on = readPlanMode(runtime);
        break;
      case "plan":
      case "changes":
      case "apply":
      case "discard": {
        // The plan commands own their notices; the prompt (and its badge) is
        // reprinted by the common showPrompt() at the end of runSlash.
        await runPlanCommand(name, arg, runtime, renderer, planState);
        break;
      }
      case "fork":
      case "sessions": {
        if (busy) {
          renderer.notice(`/${name} needs an idle chat: try again when the current answer ends`);
          break;
        }
        await runForkCommand(name, arg, runtime, renderer);
        break;
      }
      case "rename":
      case "stats":
      case "copy":
      case "export":
        await runConvoCommand(name, arg, runtime, renderer, workspace);
        break;
      case "retry": {
        if (busy) {
          renderer.notice("/retry needs an idle chat: try again when the current answer ends");
          break;
        }
        const retry = (runtime as RuntimeWithExtras).retryLast;
        if (typeof retry !== "function") {
          notSupported(renderer, "retryLast", "retry");
          break;
        }
        let again: string | undefined;
        try {
          again = retry.call(runtime);
        } catch (err) {
          renderer.notice(`could not retry: ${errorMessage(err)}`);
          break;
        }
        if (again === undefined) {
          renderer.notice("nothing to retry yet");
          break;
        }
        renderer.notice("retrying the last request");
        await sendUserText(again);
        break;
      }
      case "rewind": {
        // Rewind owns its notices too; an old core prints one typed line.
        await runRewindCommand(name, arg, runtime, renderer);
        break;
      }
      case "memory":
      case "instructions":
        runMemoryCommand(name, workspace, renderer, { sessionId: runtime.sessionId });
        break;
      case "init": {
        if (busy) {
          renderer.notice("/init needs an idle chat: try again when the current answer ends");
          break;
        }
        await runInitCommand(name, workspace, runtime, renderer, sendTurn);
        planState.on = readPlanMode(runtime);
        await drainQueue();
        break;
      }
      default: {
        // A custom command (file template) wins over a skill of the same name;
        // both are prompt text, so the expansion is sent like any typed message.
        const custom = resolveCommandForMessage(workspace, text);
        if (custom) {
          renderer.notice(`command /${custom.command.name} expanded`);
          await sendUserText(custom.prompt);
          break;
        }
        if (getSkill(workspace, body.split(/\s/)[0] ?? "")) {
          await sendUserText(text);
          break;
        }
        renderer.notice(`unknown command /${name} \u2014 try /help`);
        break;
      }
    }
    showPrompt();
  };

  const handleUserLine = async (text: string): Promise<void> => {
    try {
      // Every line the human typed is worth remembering, commands included.
      rememberHistory(historyFile, text);
      if (text.startsWith("/")) {
        await runSlash(text);
        return;
      }
      if (busy) {
        queued.push(text);
        renderer.notice(`queued \u2014 it goes next (${queued.length} waiting)`);
        // No chat bar while an answer is streaming; it returns when the turn ends.
        return;
      }
      await sendTurn(text);
      await drainQueue();
      showPrompt(true);
    } catch (err) {
      busy = false;
      renderer.error(`something went wrong: ${errorMessage(err)}`);
      showPrompt();
    }
  };

  const paste = createPasteCollector();
  const pasteOn = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (pasteOn) process.stdout.write(PASTE_ON);

  rl.on("line", (raw: string) => {
    if (pasteOn && paste.active()) {
      const pasted = paste.line(raw);
      if (pasted === undefined) return;
      if (pasted.lines > 1) {
        // Replace the echoed lines by one collapsed stand-in, submit the whole paste once.
        const promptW = visibleWidth(planPrompt(planState.on, readPermissionMode(runtime)));
        const rows = echoedRows(pasted.raw, answerWaiter ? 0 : promptW, terminalWidth());
        process.stdout.write(`\u001b[${rows}A\r\u001b[J`);
        handlePasted(pasted.text, pasteLabel(pasted.lines));
        return;
      }
      raw = pasted.text;
    }
    if (answerWaiter) {
      const waiter = answerWaiter;
      answerWaiter = null;
      try {
        rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
      } catch {
        /* ignore */
      }
      waiter(typeof raw === "string" ? raw : "");
      return;
    }
    const text = (typeof raw === "string" ? raw : "").trim();
    const wasIdle = !busy;
    if (text === "") {
      showPrompt();
      return;
    }
    if (liveOn && wasIdle && !text.startsWith("/")) {
      // Swap the plain echo for the shaded block (cursor sits just below the echo).
      const cols = Math.max(1, terminalWidth());
      const echoed = visibleWidth(planPrompt(planState.on, readPermissionMode(runtime))) + String(raw ?? "").length;
      const rows = Math.max(1, Math.ceil(echoed / cols));
      process.stdout.write(`\u001b[${rows}A\r\u001b[J`);
      echoUser(text);
    }
    void handleUserLine(text);
  });

  const handlePasted = (text: string, label: string): void => {
    if (answerWaiter) {
      // A multi-line paste is never an approval answer: it denies.
      const waiter = answerWaiter;
      answerWaiter = null;
      waiter("");
      return;
    }
    const wasIdle = !busy;
    if (wasIdle) echoUser(label);
    void handleUserLine(text);
  };

  const abortTurn = (): void => {
    if (answerWaiter) {
      const waiter = answerWaiter;
      answerWaiter = null;
      waiter("n");
    }
    if (abortRequested) return;
    abortRequested = true;
    try {
      runtime.abort();
    } catch {
      /* nothing in flight */
    }
    renderer.ensureLineStart();
    renderer.line(dim("(aborted)"));
  };

  rl.on("SIGINT", () => {
    if (busy) {
      abortTurn();
      return;
    }
    finish(0);
  });

  if (pasteOn) {
    process.stdin.on("keypress", (_s: unknown, key: { name?: string } | undefined) => {
      paste.key(key?.name);
    });
  }

  if (liveOn) {
    process.stdin.on("keypress", (_s: unknown, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      if (exiting) return;
      if (busy && key?.name === "escape" && !key.ctrl && !key.meta) {
        // Esc is a cancel only while a turn runs and no approval question is open.
        if (!answerWaiter) abortTurn();
        return;
      }
    });
  }

  rl.on("close", () => finish(0));

  // A non-default permission mode is never silent at startup.
  const startMode = readPermissionMode(runtime);
  if (startMode !== "default") renderer.notice(`permission mode: ${describeMode(startMode)}`);

  const initial = (opts.initialMessage ?? "").trim();
  if (initial !== "") {
    if (liveOn) echoUser(initial);
    else renderer.line(planPrompt(planState.on, readPermissionMode(runtime)) + sanitizeText(initial));
    void handleUserLine(initial);
  } else {
    showPrompt();
  }

  return await done;
}

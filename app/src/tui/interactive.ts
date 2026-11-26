/**
 * interactive.ts — the chat loop.
 *
 * This is the product: a small banner, then a chat bar. The human types in plain
 * language, the answer streams into the scrollback above, and the bar comes back.
 * Slash commands, approvals and Ctrl+C exist only to keep that conversation
 * flowing without ever leaving the keyboard.
 */

import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ContextUsage, GuardAction, RunExit, Runtime } from "../contracts";
import { modelsForProvider } from "../core/catalog/list-models";
import { formatModelsNotice, isModelsRefreshCommand, runModelsSlashRefresh } from "./models-slash";
import { formatDidYouMean, suggestModelIds } from "../core/catalog/model-suggest";
import { BUILTIN_COMMANDS, loadCommands, resolveCommandForMessage } from "../core/commands";
import { BUILTIN_SLASH_REGISTRY } from "../core/slash-registry";
import { combineQueuedMessages } from "../core/prompt-combine";
import { defaultConfigPath, detectAvailableProviders, loadConfig, type HzConfig } from "../core/config";
import { getSkill } from "../core/skills";
import { maskSecrets } from "../core/compaction";
import { chainLine, convoStats, lastOfRole, renderExportHtml, renderExportJson, renderStats, type ChainStatus } from "../core/convo";
import { contextChunkRows, renderContextTokenTable } from "../core/context-token-table";
import { KernelClient } from "../core/kernel";
import { guardEffectivelyAllows } from "../core/guard-g1-wire";
import { renderLearnChapter, renderLearnIndex } from "../core/learn-kb";
import { renderWorkspaceTrustReport } from "../core/trust";
import { renderSettingsReport } from "../core/settings-report";
import { renderWorkspaceLearningGraph } from "../core/learning-graph";
import { renderWorkspaceAgentGraph } from "../core/agent-graph";
import { convoExportPublication, exportSessionCli, sessionExportPublication } from "../core/session-cli";
import { homedir } from "node:os";
import { scopeFor, systemPrompt } from "../core/loop";
import { toolSpecs } from "../tools";
import { INSTRUCTION_KIND_LABEL, loadInstructionBlocks, peekLazyInstructions } from "../core/instructions";
import {
  applyHunkSelections,
  labelDiffHunkHeaders,
  parseHunkApplySelection,
  unifiedDiff,
} from "../core/plan";
import { applyHunkDecisions, parseDiffHunks, renderHunkReview } from "./hunk-review";
import { copyAssistantFromHistory } from "./clipboard";
import { formatCommandPalette } from "./command-palette";
import { bellOnTurnEnd, notifyPrefsMerged, runNotifyCommand } from "./notify";
import { buildSessionTree } from "./session-tree";
import { runWorktreeSlash } from "./worktree-slash";
import { runSnapshotSlash } from "./snapshot-slash";
import { formatTranscriptPlain } from "./transcript";
import type { SessionInfo } from "../core/session";
import type { PermissionMode } from "../core/permission-mode";
import { PERMISSION_MODES, describeMode, isPermissionMode, modeBadge, parsePermissionMode, permissionModeError } from "../core/permission-mode";
import { formatAutonomyLadderLines, runAutonomyCommand } from "./autonomy-slash";
import { historyFilePath, stateRoot } from "../core/paths";
import * as toolsModule from "../tools";
import { resolveToolRoutingConfig } from "../tools/model-tool-routing";
import type { ApprovalUi } from "./approval";
import { printBanner, printGreeting, printRichBanner, shortenPath } from "./banner";
import {
  clockTime,
  createLive,
  formatIdleStatusLine,
  liveEnabled,
  pickTip,
  readGitBranch,
  turnFooter,
  unicodeLocale,
  userBlock,
  type Live,
  type StatusInfo,
} from "./live";
import { kernelStateDir } from "../core/paths";
import { clearAbortedComposerDraft, saveAbortedComposerDraft, takeAbortedComposerDraft } from "./composer-draft";
import { unknownCountAfterEvent } from "./unknown-chip";
import { runReconcileCommand, runUnknownCommand } from "./unknown-slash";
import {
  inspectPrincipalPosture,
  readEffectHostMode,
  readEgressPosture,
  readPiiVaultStatus,
} from "./trust-spine-status";
import {
  formatReconcileBlockScrollbackNoticeLines,
  reconcileBlockScrollbackNoticeKey,
} from "./reconcile-block-chip";
import {
  printScrollbackReceiptInspect,
  resolveScrollbackReceiptInspectTarget,
  scrollbackReceiptInspectNoticeNoTarget,
  tryScrollbackHzReceiptUriLine,
} from "./scrollback-receipt-shortcut";
import { complete, formatCompletionDropdown, ghostFor, type CompletionContext } from "./completion";
import { loadUserKeymap, resolveAction } from "./keymap";
import { keyChoice, type ApprovalStageResolution, type ApprovalStageState, type KeyAnswer } from "./approval-card";
import {
  APPROVAL_GRANT_TICK_MS,
  approvalCardScreenRows,
  normalizeApprovalKeyPrompt,
  refreshApprovalCardAboveCursor,
} from "./approval-key-prompt";
import { APPROVAL_TYPE_AHEAD_MS, consumeFullscreenStagedApprovalKey } from "./fullscreen-approval";
import {
  PASTE_OFF,
  PASTE_ON,
  PASTE_SINGLE_LINE_FLUSH_MS,
  createPasteCollector,
  echoedRows,
  normalizePastedLineEndings,
  pasteLabel,
} from "./paste";
import { createDeferredSubmitGuard } from "./fullscreen-line-editor";
import { createRenderer, diffBlock, type Renderer } from "./render";
import { emitOsc7501 } from "./osc7501";
import { createDoubleEscDetector, createTurnQueueController } from "./turn-queue";
import { printSlashHelp } from "./slash-help";
import { parseSlashInput } from "./slash-dispatch";
import { activeTheme, bold, colorLevel, cyan, dim, errorMessage, sanitizeDisplay, sanitizeText, setThemeMode, strip, terminalWidth, themeMode, truncate, visibleWidth, wrapText, yellow } from "./style";
import { persistNotifyConfig, persistThemeMode } from "../core/config";

const PROMPT = "\u276f ";
const HISTORY_LIMIT = 500;

/* -------------------------- first-run onboarding -------------------------- */

/**
 * Env switch that silences the first-run onboarding notice. Truthy values follow
 * the repo convention (1/true/yes/on). Reading it is pure: no writes, no network,
 * no prompt. The notice never auto-sends data and never blocks a headless run —
 * main.ts only asks for it when a human is attached to a TTY.
 */
export const ONBOARDING_OPT_OUT_ENV = "HZ_NO_ONBOARDING";

/** The slice of a resolved config the onboarding decision looks at. */
export interface OnboardingSignals {
  provider: string;
  sources: {
    provider?: string;
    model?: string;
    apiKey?: string;
  };
}

export function onboardingOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ONBOARDING_OPT_OUT_ENV]?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * True only for a genuine first-run state: the default (mock) provider, no key
 * from env/file/store and no explicitly chosen model. A key OR an explicit model
 * means the person is already set up, so the banner/greeting stay byte-identical.
 */
export function needsOnboarding(config: OnboardingSignals, env: NodeJS.ProcessEnv = process.env): boolean {
  if (onboardingOptedOut(env)) return false;
  const sources = config?.sources;
  if (sources === undefined) return false;
  const noKey = sources.apiKey === "none";
  const defaultModel = sources.model === "default";
  const firstRunProvider = config.provider === "mock" || sources.provider === "default";
  return noKey && defaultModel && firstRunProvider;
}

/** The exact TUI lines printed after the greeting in the first-run state. */
export function onboardingNoticeLines(): readonly string[] {
  return [
    "first run: no provider key or model configured — chatting with the offline mock provider (nothing is sent)",
    "next: hzcode login <provider> (or set HZ_API_KEY), then hzcode --list-models to pick a model id",
    "or just chat offline with hzcode --mock — no key, no network",
    `hide this notice: ${ONBOARDING_OPT_OUT_ENV}=1 hzcode`,
  ];
}

/* ------------------------- interactive Ctrl-C (I-5) ------------------------ */

/**
 * What a Ctrl-C / SIGINT means in an interactive session, as a PURE decision.
 * Factored out of `runInteractive` so it can be unit-tested without a TTY (the
 * harness cannot drive readline keypress events portably).
 *
 *   - an approval is open ⇒ DENY it (answer "n"); never leave the session;
 *   - a turn is in flight and this is the FIRST Ctrl-C ⇒ CANCEL it cleanly
 *     (abort the turn, keep the chat bar, do not exit);
 *   - a turn is in flight but an abort was already requested ⇒ EXIT (the
 *     second Ctrl-C is the explicit "get me out" gesture);
 *   - idle ⇒ EXIT (readline Ctrl-C on an idle prompt has always left the chat).
 *
 * Only the scrollback interactive surface uses this; headless / print / server
 * surfaces keep their own signal handling (non-TTY behaviour is unchanged).
 */
export type InterruptAction = "deny" | "cancel" | "exit";

export interface InterruptState {
  /** True while a `runtime.send` turn is in flight. */
  busy: boolean;
  /** True once a cancel has been requested in the current turn. */
  abortRequested: boolean;
  /** True while an approval question is awaiting an answer. */
  approvalOpen: boolean;
}

export function interruptAction(state: InterruptState): InterruptAction {
  if (state.approvalOpen) return "deny";
  if (state.busy) return state.abortRequested ? "exit" : "cancel";
  return "exit";
}

/** What the TUI needs from one staged change; a core `StagedChange` fits as-is. */
export interface StagedChangeView {
  rel: string;
  resolved?: string;
  tool?: "write" | "edit";
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
export type RuntimeWithExtras = Runtime & {
  config?: HzConfig;
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
  searchSessions?: (
    query: string,
    limit?: number,
  ) => ReadonlyArray<SessionInfo & { snippet?: string; messageCount?: number; totalCostUsd?: number }>;
  /** Conversation verbs (T-12), optional like the rest. */
  history?: () => ChatMsg[];
  renameSession?: (title: string) => string;
  setGoal?: (statement: string, status?: "active" | "achieved" | "abandoned" | "blocked") => Promise<string>;
  goalStatement?: () => string | undefined;
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
  /** Restored from `tui-handoff.json` after a mode relaunch (docs/13 D2). */
  resumedDraft?: string;
  /** When true, fullscreen-experimental skips the startup resume picker (`--continue`, first message). */
  skipResumePickerOnStart?: boolean;
  /**
   * First-run onboarding lines, computed by main.ts from the resolved config and
   * only passed when a human is attached. Absent/empty means say nothing, so a
   * configured user's banner + greeting stay byte-identical.
   */
  onboardingNotice?: readonly string[];
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

/** Under-admission (ruling 601): Guard before readline history persist. */
export async function admitHistoryWrite(file: string, workspace: string): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("../core/preds-writer");
  const refused = await admitPredsOutWrite(file, workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "history refused:")
    .replace(/^preds write denied/, "history denied")
    .replace(/^preds fs\.write requires approval/, "history fs.write requires approval");
}

/** Exported for tests; `runInteractive` wires it to the live readline instance. */
export async function rememberHistory(
  file: string,
  text: string,
  workspace: string,
): Promise<string | undefined> {
  const refused = await admitHistoryWrite(file, workspace);
  if (refused !== undefined) return refused;
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
  return undefined;
}

/* ------------------------------ local text ------------------------------ */

function printHelp(r: Renderer, workspace?: string): void {
  printSlashHelp(r, workspace);
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

export function showTools(r: Renderer, runtime: Runtime): void {
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
/**
 * `/theme [dark|light|auto|mono]`: switch the palette for this session. It only
 * picks the palette: whether colour is used at all stays with the colour ladder,
 * so NO_COLOR / TERM=dumb / a pipe keep it off whatever is asked for.
 */
export function runThemeCommand(arg: string, renderer: Renderer): void {
  const want = arg.trim().toLowerCase();
  const noColor = typeof process.env.NO_COLOR === "string" && process.env.NO_COLOR !== "";
  if (want === "") {
    const mode = themeMode();
    const shown = mode === "auto" ? `auto (${activeTheme()})` : mode;
    renderer.notice(`theme: ${shown}, colour level ${colorLevel()}${noColor ? " (NO_COLOR is set)" : ""}; /theme dark|light|auto|mono`);
    return;
  }
  if (want !== "dark" && want !== "light" && want !== "auto" && want !== "mono") {
    renderer.notice(`unknown theme "${truncate(sanitizeText(arg.trim()), 24)}": use /theme dark, light, auto or mono`);
    return;
  }
  setThemeMode(want);
  try {
    void persistThemeMode(want);
  } catch {
    /* user config may be read-only */
  }
  renderer.notice(
    noColor
      ? `theme: ${want}, NO_COLOR is set, so colours stay off`
      : want === "mono"
        ? "theme: mono, no colours (bold and dim stay)"
        : `theme: ${want === "auto" ? `auto (${activeTheme()})` : want}`,
  );
}

export function runModeCommand(arg: string, runtime: Runtime, renderer: Renderer): PermissionMode {
  const extras = runtime as RuntimeWithExtras;
  const current = readPermissionMode(runtime);
  if (arg === "") {
    for (const line of formatAutonomyLadderLines(current)) {
      renderer.line(line);
    }
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
      await listStagedChanges(runtime, renderer, arg);
      return true;
    case "apply":
      await applyStagedPlan(runtime, renderer, arg);
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

/** Per-hunk review of staged diffs (docs/28 §14); never applies without /apply. */
async function reviewStagedHunks(
  renderer: Renderer,
  list: ReadonlyArray<StagedChangeView>,
): Promise<void> {
  const items = list.flatMap((change) =>
    parseDiffHunks(stagedDiff(change), sanitizeText(change?.rel ?? "") || "(unnamed)"),
  );
  if (items.length === 0) {
    renderer.notice("no hunks to review");
    return;
  }
  renderer.write(renderHunkReview(items, 0) + "\n");
  if (!process.stdin.isTTY) {
    renderer.notice("review is interactive in a TTY; apply specific hunks with /apply <path>:<hunk>");
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (val: string): void => {
        if (settled) return;
        settled = true;
        rl.off("close", onCancel);
        rl.off("SIGINT", onCancel);
        resolve(val);
      };
      const onCancel = (): void => done("skip");
      rl.once("close", onCancel);
      rl.once("SIGINT", onCancel);
      rl.question(q, (ans) => done(ans.trim().toLowerCase()));
    });
  try {
    for (let i = 0; i < items.length; i += 1) {
      const answer = await ask(`hunk ${i + 1}/${items.length} [a]ccept [r]eject [e]dit [skip]: `);
      if (answer === "skip" || answer === "q") break;
      if (answer === "a" || answer === "accept") items[i]!.decision = "accept";
      else if (answer === "r" || answer === "reject") items[i]!.decision = "reject";
      else if (answer === "e" || answer === "edit") items[i]!.decision = "edit";
      renderer.write(renderHunkReview(items, i) + "\n");
    }
    const outcome = applyHunkDecisions(items);
    if (outcome.selection !== "") {
      renderer.notice(`accepted hunks: ${outcome.selection} \u2014 run /apply ${outcome.selection} to write them`);
    } else {
      renderer.notice("no hunks accepted; nothing staged for apply");
    }
    if (outcome.pending > 0) renderer.notice(`${outcome.pending} hunk(s) left pending (edit/undecided)`);
  } finally {
    rl.close();
  }
}

async function listStagedChanges(runtime: Runtime, renderer: Renderer, arg = ""): Promise<void> {
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
  if (arg.trim() === "--review") {
    await reviewStagedHunks(renderer, list);
    return;
  }
  renderer.notice(`staged changes (${list.length}):`);
  for (const change of list) {
    const rel = sanitizeText(change?.rel ?? "") || "(unnamed)";
    renderer.line("  " + bold(rel));
    const diff = stagedDiff(change ?? { rel: "(unnamed)" });
    if (diff !== "") renderer.write(diffBlock(labelDiffHunkHeaders(diff, rel)) + "\n");
  }
}

async function applyStagedPlan(runtime: Runtime, renderer: Renderer, arg = ""): Promise<void> {
  const selection = parseHunkApplySelection(arg);
  if (selection === undefined) {
    renderer.notice("could not parse hunk apply arg; use 1,3 or path:1,2 path2:3");
    return;
  }
  if (selection !== null) {
    const staged = (runtime as RuntimeWithExtras).stagedChanges;
    if (typeof staged !== "function") {
      notSupported(renderer, "stagedChanges");
      return;
    }
    const list = (staged.call(runtime) ?? []) as StagedChangeView[];
    const coreStaged = list.map((change) => ({
      resolved: String(change?.resolved ?? change?.rel ?? ""),
      rel: String(change?.rel ?? ""),
      before: typeof change?.before === "string" || change?.before === null ? change.before : null,
      after: String(change?.after ?? ""),
      tool: change?.tool ?? ("write" as const),
    }));
    const result = applyHunkSelections(runtime.sessionId, coreStaged, selection);
    if (result.ok === false) {
      renderer.notice(result.message);
      return;
    }
    const hunks =
      selection.hunks !== undefined
        ? selection.hunks.join(",")
        : (selection.files ?? []).map((f) => `${f.rel}:${f.hunks.join(",")}`).join(" ");
    renderer.notice(`applying hunks ${hunks} on ${[...result.updated].join(", ")}`);
  }
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
export function describeSession(
  s: SessionInfo & { snippet?: string },
  currentId?: string,
): string {
  const mark = s.id === currentId ? "* " : "  ";
  const lineage =
    s.forkedFrom !== undefined
      ? ` (fork of ${sanitizeDisplay(s.forkedFrom.sessionId)} at message ${s.forkedFrom.messageIndex})`
      : "";
  const snippet = s.snippet !== undefined && s.snippet !== "" ? `\n      ${sanitizeDisplay(s.snippet)}` : "";
  return `${mark}${sanitizeDisplay(s.id)}  ${sanitizeDisplay(s.title)}${lineage}${snippet}`;
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
    const query = arg.trim();
    if (query.toLowerCase() === "tree") {
      if (typeof rt.sessions !== "function") {
        notSupported(renderer, "sessions", "sessions");
        return true;
      }
      for (const line of buildSessionTree(rt.sessions(), runtime.sessionId)) renderer.line(line);
      return true;
    }
    if (query !== "" && typeof rt.searchSessions === "function") {
      const hits = rt.searchSessions(query);
      if (hits.length === 0) renderer.notice(`no sessions matched ${JSON.stringify(query)}`);
      else for (const s of hits) renderer.line(describeSession(s, runtime.sessionId));
      return true;
    }
    if (typeof rt.searchSessions === "function") {
      for (const s of rt.searchSessions("", 500)) renderer.line(describeSession(s, runtime.sessionId));
      return true;
    }
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
      case "tokens": {
        const h = history();
        if (!h) return true;
        const usage = (runtime as RuntimeWithExtras).contextUsage?.();
        const specs = toolSpecs(runtime.sessionId).map((s) => s.name);
        const sys = systemPrompt(workspace, new Date(), {
          tools: specs,
          kernelMode: typeof (runtime as { kernelMode?: string }).kernelMode === "string" ? (runtime as { kernelMode: string }).kernelMode : "untrusted",
        });
        const provider = typeof (runtime as { providerName?: string }).providerName === "string" ? (runtime as { providerName: string }).providerName : "mock";
        renderer.notice(
          renderContextTokenTable(contextChunkRows(h, sys, usage, provider)),
        );
        return true;
      }
      case "learn": {
        const text = arg.trim() === "" ? renderLearnIndex(workspace) : renderLearnChapter(workspace, arg);
        renderer.notice(text);
        return true;
      }
      case "goal": {
        const trimmed = arg.trim();
        if (trimmed === "") {
          const current = typeof rt.goalStatement === "function" ? rt.goalStatement() : undefined;
          renderer.notice(current ? `goal: ${current}` : "no goal set — usage: /goal <statement>");
          return true;
        }
        if (typeof rt.setGoal !== "function") {
          notSupported(renderer, "setGoal", name);
          return true;
        }
        const statusWord = trimmed.toLowerCase();
        if (statusWord === "achieved" || statusWord === "abandoned" || statusWord === "blocked") {
          const current = typeof rt.goalStatement === "function" ? rt.goalStatement() : undefined;
          if (!current) {
            renderer.notice("no goal set — usage: /goal <statement>");
            return true;
          }
          await rt.setGoal(current, statusWord);
          renderer.notice(`goal ${statusWord}: ${current}`);
          return true;
        }
        const statement = await rt.setGoal(trimmed, "active");
        renderer.notice(`goal set: ${statement}`);
        const { runAutonomousGoalLoop } = await import("../core/goal-runner");
        // Generator / Evaluator Separation: with HZ_GOAL_EVALUATOR_MODEL set,
        // an independent model with its own prompt reviews each round before
        // the goal can be declared achieved. Unset keeps the legacy gate.
        const evaluatorModel = (await import("../core/goal-evaluator")).evaluatorModelFromEnv();
        let evaluator: import("../core/goal-evaluator").GoalEvaluator | undefined = undefined;
        if (evaluatorModel !== undefined) {
          const { makeProvider } = await import("../core/providers");
          const { createProviderEvaluator } = await import("../core/goal-evaluator");
          const home = process.env.HOME?.trim() || homedir();
          const cfg = loadConfig(process.env, defaultConfigPath(home), workspace);
          evaluator = createProviderEvaluator({
            provider: makeProvider({ ...cfg, model: evaluatorModel }),
            model: evaluatorModel,
          });
          renderer.notice(dim(`  Independent evaluator model: ${evaluatorModel}`));
        }
        await runAutonomousGoalLoop(trimmed, runtime, renderer, { workspace, evaluator });
        return true;
      }
      case "tasks": {
        const { loadTaskBoard } = await import("../core/task-board");
        const board = loadTaskBoard(workspace);
        if (board.items.length === 0) {
          renderer.notice(
            board.violations.length > 0
              ? `Task board has violations:\n${board.violations.map((v) => `  - ${v}`).join("\n")}`
              : "No task board configured (create .hz/wip.json). Active: 0, WIP=1",
          );
        } else {
          const lines = [
            `Task Board (WIP=1, Active: ${board.activeCount}):`,
            ...board.items.map((item) => {
              const mark =
                item.status === "passed"
                  ? "[x]"
                  : item.status === "in_progress" || item.status === "active"
                    ? "[*]"
                    : "[ ]";
              return `  ${mark} ${item.id}: ${item.name ?? "unnamed"} (${item.status ?? "pending"})`;
            }),
          ];
          if (board.violations.length > 0) {
            lines.push("\nViolations:");
            for (const v of board.violations) lines.push(`  ! ${v}`);
          }
          renderer.notice(lines.join("\n"));
        }
        return true;
      }
      case "trust": {
        const home = process.env.HOME?.trim() || homedir();
        const cfg = loadConfig(process.env, defaultConfigPath(home), workspace);
        renderer.notice(renderWorkspaceTrustReport(workspace, home, cfg.trustedWorkspaceHooks));
        return true;
      }
      case "settings": {
        const home = process.env.HOME?.trim() || homedir();
        const cfg = loadConfig(process.env, defaultConfigPath(home), workspace);
        renderer.notice(renderSettingsReport({ workspace, home, config: cfg }));
        return true;
      }
      case "graph": {
        const mode = arg.trim().toLowerCase();
        if (mode === "agent" || mode === "whole" || mode === "--agent") {
          // G-7 residual: whole-agent graph (sessions / tools / skills / proposals).
          renderer.notice(renderWorkspaceAgentGraph(workspace, toolSpecs().map((spec) => spec.name)));
        } else if (mode === "expanded" || mode === "full" || mode === "--expanded") {
          renderer.notice(renderWorkspaceLearningGraph(workspace, { expanded: true }));
        } else if (mode === "" || mode === "default" || mode === "--default") {
          // Default chain view is byte-compatible with the reduced G-7 slice.
          renderer.notice(renderWorkspaceLearningGraph(workspace));
        } else {
          renderer.notice("usage: /graph [expanded|agent]");
        }
        return true;
      }
      case "copy": {
        const h = history();
        if (!h) return true;
        const { notice } = copyAssistantFromHistory(h, write);
        renderer.notice(notice);
        return true;
      }
      case "export": {
        const format = arg.trim().toLowerCase() || "json";
        if (format !== "json" && format !== "html" && format !== "hzs") {
          renderer.notice("usage: /export [json|html|hzs]");
          return true;
        }
        if (format === "hzs") {
          // Under-admission (ruling 572): reuse CLI Guard path (569) before .hzs write.
          try {
            const result = await exportSessionCli(workspace, runtime.sessionId);
            renderer.notice(
              `exported .hzs: ${result.messageCount} message(s), ${result.checkpointCount} checkpoint(s)` +
                (result.eventCount > 0 ? `, ${result.eventCount} event(s)` : "") +
                ` → ${shortenPath(result.path)} (import not supported)`,
            );
            // H-7 (ruling 574): force-evaluate contracts; human notice unchanged.
            void sessionExportPublication(result);
          } catch (err) {
            renderer.notice(errorMessage(err));
          }
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
        const file = path.join(dir, `${runtime.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.${format}`);
        // Under-admission (ruling 572): Guard fs.write before json/html export write.
        const action: GuardAction = { kind: "fs.write", target: file };
        const kernel = new KernelClient({ workspace });
        let decision;
        try {
          await kernel.start();
          decision = await kernel.checkGuard(action, scopeFor(action, workspace));
        } catch (err) {
          renderer.notice(
            `export refused: the guard could not decide (${err instanceof Error ? err.message : String(err)})`,
          );
          return true;
        } finally {
          try {
            await kernel.close();
          } catch {
            /* ignore */
          }
        }
        if (!guardEffectivelyAllows(decision)) {
          const why =
            decision.decision === "ask"
              ? "unattended export never self-approves; allow the path in policy"
              : `denied by policy: ${decision.reason !== undefined && decision.reason !== "" ? decision.reason : "no reason given"}`;
          renderer.notice(`export refused: ${why}`);
          return true;
        }
        mkdirSync(dir, { recursive: true });
        // The export leaves the guarded state tree as a shareable file: mask secret-like values.
        writeFileSync(file, maskSecrets(format === "json" ? renderExportJson(h, meta) : renderExportHtml(h, meta)), { mode: 0o600 });
        renderer.notice(`exported ${h.length} message(s) to ${shortenPath(file)} (${chainLine(chain)})`);
        // H-7 (ruling 574): force-evaluate contracts; human notice unchanged.
        void convoExportPublication({ messageCount: h.length, format });
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

  // Tab completion (/commands and @paths). The command list is re-read at most
  // every 2 s so a new .hz/commands file shows up without a restart.
  let commandCache: { at: number; names: string[] } = { at: 0, names: [] };
  const completionCtx = (): CompletionContext => {
    if (Date.now() - commandCache.at > 2000) {
      let custom: string[] = [];
      try {
        custom = loadCommands(workspace).commands.map((c) => c.name);
      } catch {
        /* a bad commands dir never breaks completion */
      }
      commandCache = { at: Date.now(), names: [...BUILTIN_COMMANDS, ...custom] };
    }
    return { workspace, commands: commandCache.names };
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string): [string[], string] => {
      try {
        const result = complete(line, completionCtx());
        // Scrollback-safe popup: print a one-shot box above the prompt when Tab
        // yields multiple hits (docs/33 §5.18). Single-hit Tab still completes
        // silently through readline.
        if (result[0].length > 1) {
          const box = formatCompletionDropdown(result[0], 0);
          if (box !== "") process.stdout.write(`\n${box}\n`);
        }
        return result;
      } catch {
        return [[], line];
      }
    },
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });

  let busy = false;
  let exiting = false;
  let abortRequested = false;
  let focusModeOn = false;
  let answerWaiter: ((line: string) => void) | null = null;
  let typedGuardArmed = false;
  const queued: string[] = [];
  const turnQueue = createTurnQueueController();
  const doubleEsc = createDoubleEscDetector();
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  let live: Live | undefined;
  let contextPercent: number | undefined;
  let contextUsed: number | undefined;
  let contextWindowTokens: number | undefined;
  let unknownCount = 0;
  let unknownReceiptId: string | undefined;

  const renderer: Renderer = createRenderer({
    wrap: true,
    rich: liveEnabled(),
    focusMode: () => focusModeOn,
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
    const principal = inspectPrincipalPosture();
    return {
      badge: planState.on ? "PLAN" : modeBadge(readPermissionMode(runtime)),
      model: runtime.model,
      provider: runtime.providerName,
      contextPercent,
      contextUsed,
      contextWindow: contextWindowTokens,
      path: shortenPath(workspace),
      branch: branchCache.value,
      unknownCount: unknownCount > 0 ? unknownCount : undefined,
      unknownReceiptId: unknownCount === 1 ? unknownReceiptId : undefined,
      reconcileBlock: hz.reconcileBlockLatch?.(),
      effectHostMode: readEffectHostMode(),
      egressPosture: readEgressPosture(runtime),
      piiVault: readPiiVaultStatus(runtime),
      principalMode: principal.principalMode,
      principalKeyFingerprint: principal.principalKeyFingerprint,
    };
  };
  const hz = runtime as import("../core").HzRuntime;
  let reconcileBlockNoticeKeySeen = "";
  const emitReconcileBlockScrollbackNoticeIfNeeded = (): void => {
    const view = hz.reconcileBlockLatch?.();
    if (!view) return;
    const key = reconcileBlockScrollbackNoticeKey(view);
    if (key === reconcileBlockNoticeKeySeen) return;
    reconcileBlockNoticeKeySeen = key;
    if ((view.latched || view.observePendingActive) && view.mode !== "off") {
      for (const line of formatReconcileBlockScrollbackNoticeLines(view)) {
        renderer.notice(line);
      }
    }
  };
  const syncReconcileBlockScrollbackNotice = (): void => {
    emitReconcileBlockScrollbackNoticeIfNeeded();
    if (!busy && answerWaiter === null) live?.showIdle();
  };
  live = createLive({
    enabled: liveEnabled(),
    write: (chunk) => void process.stdout.write(chunk),
    status: statusInfo,
    statusScript: hz.config?.statusLine,
    statusSpawn: { workspace, stateDir: kernelStateDir(workspace) },
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
  ui.ask = (question: string, askOpts?: { signal?: AbortSignal }) =>
    new Promise<string>((resolve) => {
      const signal = askOpts?.signal;
      if (signal?.aborted) {
        resolve("");
        return;
      }
      let settled = false;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (answerWaiter === waiter) answerWaiter = null;
        cleanup();
        try {
          rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
          if (!exiting && !busy) rl.prompt();
        } catch {
          /* ignore */
        }
        resolve("");
      };
      const waiter = (line: string): void => {
        if (settled) return;
        settled = true;
        if (answerWaiter === waiter) answerWaiter = null;
        cleanup();
        resolve(line);
      };
      answerWaiter = waiter;
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        rl.setPrompt(question);
        rl.prompt();
      } catch {
        if (!settled) {
          settled = true;
          if (answerWaiter === waiter) answerWaiter = null;
          cleanup();
          resolve("");
        }
      }
    });

  // Rich TTY: the approval question is a bordered card answered by one key (no
  // Enter). Type-ahead can never approve: whatever was typed before the card is
  // wiped, and keys in its first 250 ms are dropped. Enter and Esc deny.
  if (liveOn && canEsc) {
    ui.unicode = unicodeLocale();
    const wipeLine = (): void => {
      try {
        rl.write(null as unknown as string, { ctrl: true, name: "u" });
      } catch {
        /* nothing to wipe */
      }
    };
    ui.askKey = (prompt) =>
      new Promise<KeyAnswer>((resolve) => {
        const { screenRows, onTick } = normalizeApprovalKeyPrompt(prompt);
        const armedAt = Date.now() + 250;
        let settled = false;
        let tickTimer: ReturnType<typeof setInterval> | undefined;
        const writeCard = (chunk: string): void => {
          process.stdout.write(chunk);
        };
        try {
          rl.pause();
        } catch {
          /* readline may already be paused */
        }
        const settle = (answer: KeyAnswer): void => {
          if (settled) return;
          settled = true;
          if (tickTimer !== undefined) clearInterval(tickTimer);
          process.stdin.off("keypress", onKey);
          answerWaiter = null;
          wipeLine();
          try {
            rl.resume();
          } catch {
            /* closed */
          }
          resolve(answer);
        };
        const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
          // Pasted text is never a typed answer: a paste of "y" must not approve.
          if (Date.now() < armedAt || paste.pasting() || key?.name === "paste-start" || key?.name === "paste-end") {
            wipeLine();
            return;
          }
          const choice = keyChoice(str, key);
          if (choice !== undefined) settle(choice);
          else wipeLine();
        };
        if (onTick) {
          tickTimer = setInterval(() => {
            if (settled) return;
            try {
              refreshApprovalCardAboveCursor(writeCard, screenRows, onTick());
            } catch {
              /* terminal went away */
            }
          }, APPROVAL_GRANT_TICK_MS);
          (tickTimer as { unref?: () => void }).unref?.();
        }
        wipeLine();
        // The line path (Enter, abort) is a denial; only a recognised key can say yes.
        answerWaiter = () => settle("n");
        process.stdin.on("keypress", onKey);
      });

    ui.askStagedKey = (prompt, initial) =>
      new Promise<ApprovalStageResolution>((resolve) => {
        const { screenRows, onTick, renderStage } = normalizeApprovalKeyPrompt(prompt);
        let state: ApprovalStageState = initial;
        let armedAt = Date.now() + APPROVAL_TYPE_AHEAD_MS;
        let currentRows = screenRows;
        let settled = false;
        let tickTimer: ReturnType<typeof setInterval> | undefined;
        const writeCard = (chunk: string): void => {
          process.stdout.write(chunk);
        };
        try {
          rl.pause();
        } catch {
          /* readline may already be paused */
        }
        const settle = (resolution: ApprovalStageResolution): void => {
          if (settled) return;
          settled = true;
          if (tickTimer !== undefined) clearInterval(tickTimer);
          process.stdin.off("keypress", onKey);
          answerWaiter = null;
          wipeLine();
          try {
            rl.resume();
          } catch {
            /* closed */
          }
          resolve(resolution);
        };
        const redraw = (nextLines: string[]): void => {
          try {
            refreshApprovalCardAboveCursor(writeCard, currentRows, nextLines);
            currentRows = approvalCardScreenRows(nextLines.length);
          } catch {
            /* terminal went away */
          }
        };
        const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined): void => {
          const now = Date.now();
          const outcome = consumeFullscreenStagedApprovalKey(
            state,
            armedAt,
            now,
            paste.pasting(),
            key,
            str,
          );
          if (outcome.kind === "paste-block" || outcome.kind === "ignore") {
            wipeLine();
            return;
          }
          if (outcome.kind === "transition") {
            const prevStage = state.stage;
            state = outcome.state;
            if (prevStage !== "always_confirm" && state.stage === "always_confirm") {
              armedAt = now + APPROVAL_TYPE_AHEAD_MS;
            }
            const nextLines = renderStage?.(state);
            if (nextLines) redraw(nextLines);
            wipeLine();
            return;
          }
          settle(outcome.resolution);
        };
        if (onTick) {
          tickTimer = setInterval(() => {
            if (settled || state.stage !== "permission") return;
            redraw(onTick());
          }, APPROVAL_GRANT_TICK_MS);
          (tickTimer as { unref?: () => void }).unref?.();
        }
        wipeLine();
        answerWaiter = () => settle({ kind: "declined" });
        process.stdin.on("keypress", onKey);
      });
  }

  const historyFile = historyFilePath(workspace);
  loadHistory(historyFile, rl);
  const resumedDraft = (opts.resumedDraft ?? "").trim();
  if (resumedDraft !== "") {
    (rl as unknown as { line: string }).line = resumedDraft;
    renderer.notice(`restored relaunch draft (${resumedDraft.length} characters)`);
  }

  const out = (chunk: string): void => renderer.write(chunk);
  const bannerInfo = { version: opts.version, model: runtime.model, provider: runtime.providerName, workspace, kernel: runtime.kernelMode };
  if (liveOn) printRichBanner(bannerInfo, { out, tip: pickTip() });
  else printBanner(bannerInfo, { out });
  printGreeting({ out });
  // First-run guidance is printed after the unchanged banner/greeting and only
  // when main.ts detected a fresh, unconfigured state on an interactive TTY.
  if (opts.onboardingNotice !== undefined) {
    for (const line of opts.onboardingNotice) renderer.notice(line);
  }

  let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const stdinKeypressListeners: Array<(...args: any[]) => void> = [];

  const finish = (code: number): void => {
    if (exiting) return;
    exiting = true;
    if (answerWaiter !== null) {
      const waiter = answerWaiter;
      answerWaiter = null;
      waiter("");
    }
    if (pasteFlushTimer !== undefined) {
      clearTimeout(pasteFlushTimer);
      pasteFlushTimer = undefined;
    }
    for (const listener of stdinKeypressListeners.splice(0)) {
      try {
        process.stdin.off("keypress", listener);
      } catch {
        /* ignore */
      }
    }
    live?.dispose();
    emitOsc7501((c) => process.stdout.write(c), "idle");
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

  const tryRestoreAbortedDraft = (): void => {
    const state = rl as unknown as { line?: string };
    if (String(state.line ?? "").trim() !== "") return;
    const draft = takeAbortedComposerDraft(workspace, runtime.sessionId);
    if (draft === undefined || draft === "") return;
    state.line = draft;
    renderer.notice(`restored aborted draft (${draft.length} characters)`);
  };

  const showPrompt = (blank = false): void => {
    if (exiting) return;
    typedGuardArmed = false;
    if (blank) renderer.write("\n");
    try {
      rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
      if (renderer.atLineStart()) syncReconcileBlockScrollbackNotice();
      if (!busy && answerWaiter === null) tryRestoreAbortedDraft();
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
    emitOsc7501((c) => process.stdout.write(c), "working");
    let turnHadError = false;
    try {
      const result = await runtime.send(text, {
        onEvent: (ev) => {
          if (ev && typeof ev === "object") {
            unknownCount = unknownCountAfterEvent(unknownCount, ev);
            if (ev.type === "effect.unknown" && typeof ev.receiptId === "string" && ev.receiptId !== "") {
              unknownReceiptId = ev.receiptId;
            } else if (ev.type === "effect.reconciled" && unknownCount === 0) {
              unknownReceiptId = undefined;
            }
            if (ev.type === "tool.card") {
              if (ev.status === "running") live?.toolStart(String(ev.name), ev.args, String(ev.callId));
              else live?.toolEnd(String(ev.callId));
            } else if (ev.type === "context.usage") {
              if (ev.window > 0) {
                contextUsed = ev.estimatedInput;
                contextWindowTokens = ev.window;
                contextPercent = (ev.estimatedInput / ev.window) * 100;
              }
              live?.noteUsage(ev.estimatedInput);
            } else if (ev.type === "error" && ev.code === "AUTH") {
              const msg = typeof ev.message === "string" ? ev.message : "";
              if (msg.includes("gsk_")) {
                renderer.notice("hint: this key starts with 'gsk_', which is a Groq key (not OpenAI). Set HZ_BASE_URL=https://api.groq.com/openai/v1 or switch provider.");
              }
              const available = detectAvailableProviders(process.env);
              const curProv = (runtime as RuntimeWithExtras).providerName;
              const others = available.filter((p) => p !== curProv);
              if (others.length > 0) {
                renderer.notice(`hint: working credentials detected for ${others.join(", ")}. Switch with: hzcode --provider ${others[0]}`);
              }
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
      turnHadError = true;
      emitOsc7501((c) => process.stdout.write(c), "error");
      renderer.error(`request failed: ${errorMessage(err)}`);
    } finally {
      busy = false;
      if (!turnHadError) emitOsc7501((c) => process.stdout.write(c), "done");
      emitReconcileBlockScrollbackNoticeIfNeeded();
      const stats = live?.endTurn();
      renderer.ensureLineStart();
      if (stats && liveOn) {
        renderer.write(
          turnFooter({ ms: stats.ms, tools: stats.tools, inputTokens: stats.inputTokens, time: clockTime(), width: terminalWidth() - 1 }) + "\n",
        );
        bellOnTurnEnd(
          stats.ms,
          notifyPrefsMerged(loadConfig(process.env, defaultConfigPath(process.env.HOME?.trim() || homedir())).notify),
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
      const combined = combineQueuedMessages(queued);
      queued.length = 0;
      queued.push(...combined.remaining);
      if (combined.combinedCount > 1) {
        renderer.notice(`combined ${combined.combinedCount} queued prompts into one turn`);
      }
      echoUser(combined.head);
      await sendTurn(combined.head);
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

  const showModels = (): void => {
    const rt = runtime as RuntimeWithExtras;
    const provider = rt.providerName ?? "unknown";
    const list = modelsForProvider(provider, rt.config ?? {});
    renderer.notice(formatModelsNotice(provider, list));
  };

  /**
   * Pause the outer readline interface and temporarily detach conflicting
   * keypress listeners while a modal owns `process.stdin`, then cleanly
   * restore listeners, raw mode, and outer `rl` in `finally`.
   */
  const withExclusiveStdin = async <T>(fn: () => Promise<T>): Promise<T> => {
    live?.erase();
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (on: boolean) => void };
    const wasRaw = stdin.isRaw === true;
    const savedKeypress = stdin.rawListeners("keypress").slice();
    try {
      rl.pause();
    } catch {
      /* already paused */
    }
    stdin.removeAllListeners("keypress");
    try {
      return await fn();
    } finally {
      for (const listener of savedKeypress) {
        stdin.on("keypress", listener as (...args: unknown[]) => void);
      }
      if (!exiting) {
        try {
          if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
        } catch {
          /* terminal went away */
        }
        try {
          stdin.resume();
        } catch {
          /* ignore */
        }
        try {
          rl.resume();
        } catch {
          /* already closed */
        }
      }
    }
  };

  const showOrSetModel = async (arg: string): Promise<void> => {
    const rt = runtime as RuntimeWithExtras;
    const provider = rt.providerName ?? "unknown";
    const list = modelsForProvider(provider, rt.config ?? {});
    if (arg.trim() === "--select") {
      // The arrow-key/filter picker is explicit so bare `/model` keeps its
      // scrollback notice and never blocks a scripted or PTY session (742).
      if (process.stdin.isTTY) {
        const { runInteractiveModelPicker } = await import("./interactive-model-picker");
        const res = await withExclusiveStdin(() => runInteractiveModelPicker(runtime, renderer));
        if (res.switched && res.model) return;
      } else {
        renderer.notice("interactive model picker needs a TTY; use /model <name>");
      }
      return;
    }
    if (arg === "") {
      const available = detectAvailableProviders(process.env);
      const provInfo = available.length > 0 ? ` \u00b7 configured providers: ${available.join(", ")}` : "";
      renderer.notice(`model ${runtime.model} \u00b7 provider ${provider}${provInfo}`);
      if (list.length > 0) {
        renderer.notice(formatModelsNotice(provider, list));
        renderer.notice(`switch model: /model <name> (e.g. /model ${list[0]})`);
      } else {
        renderer.notice(`switch model: /model <name>`);
      }
      return;
    }
    const setModel = (runtime as RuntimeWithExtras).setModel;
    if (typeof setModel !== "function") {
      renderer.notice(`this session stays on ${runtime.model} \u2014 start with hzcode --model ${arg} to use another model`);
      return;
    }
    let target = arg.trim();
    if (list.length > 0 && !list.includes(target)) {
      const substrMatches = list.filter((id) => id.toLowerCase().includes(target.toLowerCase()));
      if (substrMatches.length === 1) {
        target = substrMatches[0];
      } else if (substrMatches.length > 1) {
        const prefixMatch = substrMatches.find((id) => id.toLowerCase().startsWith(target.toLowerCase()));
        if (prefixMatch) {
          target = prefixMatch;
        } else {
          renderer.notice(`multiple models match "${arg}": ${substrMatches.slice(0, 5).join(", ")}`);
          renderer.notice(`specify exact model: /model <name>`);
          return;
        }
      } else {
        const suggestions = suggestModelIds(target, list);
        if (suggestions.length > 0) {
          renderer.notice(formatDidYouMean(target, suggestions));
        }
      }
    }
    try {
      const applied = (await Promise.resolve(setModel.call(runtime, target))) as unknown;
      renderer.notice(`model \u2192 ${typeof applied === "string" && applied !== "" ? applied : target}`);
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

  /** Send text as if typed: steer mid-turn when possible, else queue for next turn. */
  const sendUserText = async (text: string): Promise<void> => {
    if (busy) {
      const interject = (
        runtime as { interject?: (t: string, opts?: { mode?: "steer" | "interrupt" }) => { accepted: boolean } }
      ).interject;
      if (typeof interject === "function") {
        // Chat-bar Enter during a turn is an explicit <system-interrupt> steer:
        // the model is redirected at the next step, the turn is not aborted.
        const outcome = interject.call(runtime, text, { mode: "interrupt" });
        if (outcome?.accepted === true) {
          echoUser(text);
          renderer.notice("steered \u2014 your message joins the current turn at the next step");
          return;
        }
      }
      queued.push(text);
      renderer.notice(`queued \u2014 it goes next (${queued.length} waiting)`);
      return;
    }
    await sendTurn(text);
    await drainQueue();
  };

  const runSlash = async (text: string): Promise<void> => {
    const parsed = parseSlashInput(text);
    if (parsed === null) return;
    const { name, arg } = parsed;

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
      case "auth":
      case "login": {
        const { runAuthWizard } = await import("./onboarding-wizard");
        const res = await withExclusiveStdin(() => runAuthWizard());
        if (res.configured && res.provider) {
          renderer.notice(`configured provider ${res.provider} (credentials stored in ${res.savedPath})`);
          const available = detectAvailableProviders(process.env);
          renderer.notice(`active configured providers: ${available.join(", ")}`);
        }
        break;
      }
      case "models":
        if (isModelsRefreshCommand(arg)) {
          const { notice } = await runModelsSlashRefresh({ env: process.env });
          renderer.notice(notice);
        } else {
          showModels();
        }
        break;
      case "files":
        showTools(renderer, runtime);
        break;
      case "context":
        showContext();
        break;
      case "status":
        renderer.notice(strip(formatIdleStatusLine(statusInfo(), terminalWidth() - 1, { plain: true })));
        if (unknownCount > 0) await runUnknownCommand(runtime, renderer);
        break;
      case "unknown":
        await runUnknownCommand(runtime, renderer, arg);
        break;
      case "reconcile":
        await runReconcileCommand(runtime, renderer, arg);
        break;
      case "skill":
        await runSkillSlashCommand(arg, runtime, renderer, workspace);
        break;
      case "focus":
        focusModeOn = !focusModeOn;
        renderer.notice(
          focusModeOn
            ? "focus mode ON \u2014 collapsing intermediate tool chatter to prompt + diffstat + final response"
            : "focus mode OFF \u2014 showing full tool cards and notices",
        );
        break;
      case "btw": {
        const q = arg.trim();
        if (q === "") {
          renderer.notice("usage: /btw <side-question>");
          break;
        }
        await sendUserText(`[btw side-question — answer concisely without changing the main task] ${q}`);
        break;
      }
      case "theme":
        runThemeCommand(arg, renderer);
        break;
      case "notify": {
        const home = process.env.HOME?.trim() || homedir();
        const cfg = loadConfig(process.env, defaultConfigPath(home), workspace);
        runNotifyCommand(arg, renderer, cfg.notify, (prefs) => { void persistNotifyConfig(prefs, home); });
        break;
      }
      case "mode":
        runModeCommand(arg, runtime, renderer);
        // /mode plan flips the runtime's plan flag: keep the badge in step.
        planState.on = readPlanMode(runtime);
        break;
      case "autonomy":
        runAutonomyCommand(arg, runtime, renderer, () => readPermissionMode(runtime));
        planState.on = readPlanMode(runtime);
        break;
      case "plan":
      case "changes":
      case "apply":
      case "discard": {
        // The plan commands own their notices; the prompt (and its badge) is
        // reprinted by the common showPrompt() at the end of runSlash.
        if (name === "changes" && arg.trim() === "--review" && process.stdin.isTTY) {
          await withExclusiveStdin(() => runPlanCommand(name, arg, runtime, renderer, planState));
        } else {
          await runPlanCommand(name, arg, runtime, renderer, planState);
        }
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
      case "worktree":
        runWorktreeSlash(workspace, renderer);
        break;
      case "snapshot":
        runSnapshotSlash(renderer);
        break;
      case "think": {
        const text = renderer.lastThinking?.() ?? "";
        if (text.trim() === "") {
          renderer.notice("no reasoning block yet, only models that stream their thinking have one");
          break;
        }
        for (const l of sanitizeText(text).trimEnd().split("\n")) renderer.line(dim("\u2503 " + l));
        break;
      }
      case "palette":
      case "commands": {
        let custom: string[] = [];
        try {
          custom = loadCommands(workspace).commands.map((c) => c.name);
        } catch {
          /* ignore */
        }
        if (arg === "" && process.stdin.isTTY) {
          const { runInteractiveCommandPalette } = await import("./interactive-command-palette");
          const { DEFAULT_PALETTE_SHORTCUTS, parseRecentFilesFromGitStatus, paletteToggles } = await import("./palette-extras");
          // Expanded palette context (docs/28 §14): shortcuts, changed files,
          // active skills and quick toggles. Every probe is best-effort and
          // read-only; a failed probe simply omits that section.
          let recentFiles: string[] = [];
          try {
            const status = spawnSync("git", ["status", "--short"], {
              cwd: workspace,
              encoding: "utf8",
              timeout: 2000,
            });
            if (status.status === 0 && typeof status.stdout === "string") {
              recentFiles = parseRecentFilesFromGitStatus(status.stdout);
            }
          } catch {
            /* no git or no repo: omit the section */
          }
          let activeSkills: string[] = [];
          try {
            const { listSkills } = await import("../core/skills");
            activeSkills = listSkills(workspace).map((s) => s.name);
          } catch {
            /* omit the section */
          }
          let theme: string | undefined;
          let autonomy: string | undefined;
          try {
            const cfg = loadConfig(process.env, defaultConfigPath(process.env.HOME?.trim() || homedir()), workspace);
            theme = cfg.theme;
            autonomy = cfg.autonomy;
          } catch {
            /* omit current values */
          }
          const chosen = await withExclusiveStdin(() =>
            runInteractiveCommandPalette(custom, {
              extras: {
                shortcuts: [...DEFAULT_PALETTE_SHORTCUTS],
                recentFiles,
                activeSkills,
                toggles: paletteToggles({ theme, autonomy }),
              },
            }),
          );
          if (chosen) {
            await runSlash(chosen);
            return;
          }
        }
        const box = formatCommandPalette(arg, { customNames: custom });
        if (box !== "") process.stdout.write(`\n${box}\n`);
        break;
      }
      case "transcript": {
        const hist = (runtime as RuntimeWithExtras).history;
        if (typeof hist !== "function") {
          notSupported(renderer, "history", "transcript");
          break;
        }
        const h = hist.call(runtime);
        if (!h || h.length === 0) {
          renderer.notice("transcript is empty");
          break;
        }
        const body = formatTranscriptPlain(h);
        const pager = process.env.PAGER?.trim() || "less";
        if (process.stdout.isTTY) {
          await withExclusiveStdin(async () => {
            const r = spawnSync(pager, pager === "less" ? ["-R"] : [], { input: body, stdio: ["pipe", "inherit", "inherit"] });
            if (r.error) renderer.write(body);
          });
        } else {
          renderer.write(body);
        }
        break;
      }
      case "rename":
      case "stats":
      case "tokens":
      case "learn":
      case "goal":
      case "tasks":
      case "trust":
      case "settings":
      case "graph":
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
        if (getSkill(workspace, name)) {
          await sendUserText(text);
          break;
        }
        // Autocomplete unique prefix match across BUILTIN_SLASH_REGISTRY:
        const lowerName = name.toLowerCase();
        const matches = BUILTIN_SLASH_REGISTRY.filter(
          (r) => r.name.startsWith(lowerName) || (r.aliases ?? []).some((a) => a.startsWith(lowerName))
        );
        if (matches.length === 1) {
          const matched = matches[0]!;
          if (matched.name !== lowerName) {
            renderer.notice(`auto-completing /${name} \u2192 /${matched.name}`);
            const rewritten = `/${matched.name}${arg ? " " + arg : ""}`;
            await runSlash(rewritten);
            return;
          }
        } else if (matches.length > 1) {
          renderer.notice(`ambiguous command /${name} \u2014 matches: ${matches.map((m) => "/" + m.name).join(", ")}`);
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
      await rememberHistory(historyFile, text, workspace);
      clearAbortedComposerDraft(workspace, runtime.sessionId);
      if (tryScrollbackHzReceiptUriLine(runtime, renderer, text)) {
        showPrompt();
        return;
      }
      if (text.startsWith("/")) {
        await runSlash(text);
        return;
      }
      await sendUserText(text);
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
  const submitGuard = createDeferredSubmitGuard({ immediate: !pasteOn });
  const queuedSubmitLines: string[] = [];
  const submitOrQueueLine = (line: string): void => {
    const drainNext = () => {
      if (queuedSubmitLines.length > 0 && !exiting) {
        const next = queuedSubmitLines.shift()!;
        setTimeout(() => submitOrQueueLine(next), 0);
      }
    };
    if (!submitGuard.request(() => handleUserLine(line).finally(drainNext))) {
      if (busy) {
        void handleUserLine(line);
      } else {
        queuedSubmitLines.push(line);
      }
    }
  };

  rl.on("line", (raw: string) => {
    if (pasteOn && paste.active()) {
      const pasted = paste.line(raw);
      if (pasted === undefined) return;
      if (answerWaiter !== null) {
        const waiter = answerWaiter;
        answerWaiter = null;
        try {
          rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
        } catch {
          /* ignore */
        }
        waiter("");
        return;
      }
      if (pasted.lines > 1) {
        // Replace the echoed lines by one collapsed stand-in, submit the whole paste once.
        const promptW = visibleWidth(planPrompt(planState.on, readPermissionMode(runtime)));
        const rows = echoedRows(pasted.raw, promptW, terminalWidth());
        process.stdout.write(`\u001b[${rows}A\r\u001b[J`);
        handlePasted(pasted.text, pasteLabel(pasted.lines));
        return;
      }
      raw = normalizePastedLineEndings(pasted.text);
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
    submitOrQueueLine(text);
  });

  const handlePasted = (text: string, label: string): void => {
    const normalized = normalizePastedLineEndings(text);
    if (answerWaiter) {
      // Any bracketed paste is never an approval answer: it denies.
      const waiter = answerWaiter;
      answerWaiter = null;
      waiter("");
      return;
    }
    const wasIdle = !busy;
    if (wasIdle) echoUser(label);
    submitOrQueueLine(normalized);
  };

  /** Cancel the in-flight turn cleanly (no exit). The approval-deny branch of
   * Ctrl-C is handled by `handleInterrupt`, not here, so Esc-cancel keeps its
   * "no approval open" guard in the keymap listener below. */
  const abortTurn = (): void => {
    const drafting = String((rl as unknown as { line?: string }).line ?? "");
    if (drafting.trim() !== "") {
      // Best-effort (ruling 586): admit then persist; refuse is silent on abort.
      void saveAbortedComposerDraft(workspace, runtime.sessionId, drafting);
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

  /** I-5: one Ctrl-C cancels the turn; a second (or Ctrl-C while idle) exits;
   * Ctrl-C with an approval open denies it. The decision itself is the pure
   * `interruptAction` above — this function only applies it. */
  const handleInterrupt = (): void => {
    submitGuard.cancel();
    const action = interruptAction({
      busy,
      abortRequested,
      approvalOpen: answerWaiter !== null,
    });
    switch (action) {
      case "deny": {
        const waiter = answerWaiter;
        answerWaiter = null;
        waiter?.("n");
        return;
      }
      case "cancel":
        abortTurn();
        return;
      case "exit":
        finish(130);
        return;
    }
  };

  rl.on("SIGINT", handleInterrupt);

  // Dim ghost text after the cursor: the rest of the first completion. It is
  // erased BEFORE readline handles Enter (prepended listener) and redrawn after
  // every other key; only drawn when the cursor is at the end of an idle line.
  if (liveOn && canEsc) {
    let ghostShown = false;
    const eraseGhost = (): void => {
      if (!ghostShown) return;
      ghostShown = false;
      process.stdout.write("\u001b[K");
    };
    const onGhostEnter = (_s: unknown, key: { name?: string } | undefined): void => {
      if (key?.name === "return" || key?.name === "enter") eraseGhost();
    };
    const onGhostDraw = (): void => {
      setImmediate(() => {
        if (exiting) return;
        eraseGhost();
        if (busy || answerWaiter !== null) return;
        const state = rl as unknown as { line?: string; cursor?: number };
        const line = String(state.line ?? "");
        if (line === "" || state.cursor !== line.length) return;
        const ghost = ghostFor(line, completionCtx());
        if (ghost === "") return;
        const ghostW = visibleWidth(ghost);
        const room = terminalWidth() - visibleWidth(planPrompt(planState.on, readPermissionMode(runtime))) - visibleWidth(line) - 1;
        if (ghostW > room) return;
        ghostShown = true;
        process.stdout.write(dim(ghost) + `\u001b[${ghostW}D`);
      });
    };
    stdinKeypressListeners.push(onGhostEnter, onGhostDraw);
    process.stdin.prependListener("keypress", onGhostEnter);
    process.stdin.on("keypress", onGhostDraw);
  }

  if (pasteOn) {
    const submitPaste = (pasted: { text: string; lines: number; raw: string[] }): void => {
      if (answerWaiter !== null) {
        const waiter = answerWaiter;
        answerWaiter = null;
        try {
          rl.setPrompt(planPrompt(planState.on, readPermissionMode(runtime)));
        } catch {
          /* ignore */
        }
        waiter("");
        return;
      }
      if (pasted.lines > 1) {
        const promptW = visibleWidth(planPrompt(planState.on, readPermissionMode(runtime)));
        const rows = echoedRows(pasted.raw, promptW, terminalWidth());
        process.stdout.write(`\u001b[${rows}A\r\u001b[J`);
        handlePasted(pasted.text, pasteLabel(pasted.lines));
        return;
      }
      void handleUserLine(normalizePastedLineEndings(pasted.text));
    };
    const onPasteKey = (_s: unknown, key: { name?: string } | undefined): void => {
      paste.key(key?.name);
      if (key?.name === "paste-end") {
        if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
        pasteFlushTimer = setTimeout(() => {
          pasteFlushTimer = undefined;
          const flushed = paste.flushAfterEnd();
          if (flushed) submitPaste(flushed);
        }, PASTE_SINGLE_LINE_FLUSH_MS);
      }
    };
    stdinKeypressListeners.push(onPasteKey);
    process.stdin.on("keypress", onPasteKey);
  }

  if (liveOn) {
    const loaded = loadUserKeymap();
    for (const err of loaded.errors) renderer.notice(`keybind: ${err}`);
    const keymap = loaded.keymap;
    const onKeymapKey = (_s: unknown, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined): void => {
      if (exiting) return;
      // Esc cancel goes through the keymap table (docs/33 §5.19); approval keeps Esc inert.
      if (resolveAction(keymap, key, busy ? "busy" : "idle")?.id === "turn.cancel" && !answerWaiter) {
        abortTurn();
        return;
      }
      if (key?.name === "escape" && !busy && answerWaiter === null) {
        const line = String((rl as unknown as { line?: string }).line ?? "");
        if (line.trim() === "" && doubleEsc.onEscape()) {
          const latched = hz.reconcileBlockLatch?.()?.latched === true;
          void runSlash(unknownCount > 0 || latched ? "/reconcile" : "/rewind");
        }
        return;
      }
      if (key?.name !== "escape") doubleEsc.reset();
      if (key?.name === "tab" && busy && answerWaiter === null) {
        const state = rl as unknown as { line?: string; cursor?: number };
        const draft = String(state.line ?? "").trim();
        if (draft !== "") {
          void turnQueue.withCommitGuard(() => {
            queued.push(draft);
            state.line = "";
            state.cursor = 0;
            renderer.notice(`queued (FIFO) \u2014 it goes next (${queued.length} waiting)`);
          });
        }
      }
    };
    stdinKeypressListeners.push(onKeymapKey);
    process.stdin.on("keypress", onKeymapKey);
  }

  if (process.stdin.isTTY) {
    const onReceiptShortcutKey = (_s: unknown, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (exiting || busy || answerWaiter !== null) return;
      if (!key?.ctrl || key.name !== "i") return;
      const target = resolveScrollbackReceiptInspectTarget(unknownReceiptId);
      if (!target) {
        renderer.notice(scrollbackReceiptInspectNoticeNoTarget());
        return;
      }
      printScrollbackReceiptInspect(runtime, renderer, target);
    };
    stdinKeypressListeners.push(onReceiptShortcutKey);
    process.stdin.on("keypress", onReceiptShortcutKey);
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

const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Host-gated `/skill save <name> [description]` sub-handler (Wave A / Track A4).
 *
 * Uses dynamic feature-detection for `saveVerifiedSkill` (`../core/skills`) and
 * `getLastVerifiedCodemodeScript` (`../tools/codemode`) so Track A4 compiles
 * cleanly even before Track A3 lands.
 */
export async function runSkillSlashCommand(
  arg: string,
  runtime: Runtime,
  renderer: Renderer,
  workspace: string,
): Promise<void> {
  const raw = arg.trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "").toLowerCase();

  if (sub === "" || sub === "list") {
    try {
      const skillsMod = (await import("../core/skills")) as {
        listSkills?: (ws: string) => Array<{ name: string; description?: string }>;
      };
      const listed = typeof skillsMod.listSkills === "function" ? skillsMod.listSkills(workspace) : [];
      if (listed.length === 0) {
        renderer.notice("no skills installed — use /skill save <name> [description] after a verified code_mode run");
      } else {
        renderer.notice(`skills (${listed.length}): ${listed.map((s) => s.name).join(", ")}`);
      }
    } catch {
      renderer.notice("usage: /skill save <name> [description]");
    }
    return;
  }

  if (sub !== "save") {
    renderer.notice("usage: /skill save <name> [description]");
    return;
  }

  const name = parts[1]?.trim() ?? "";
  const description = parts.slice(2).join(" ").trim();
  if (name === "" || name.startsWith(".") || !SAFE_SKILL_NAME.test(name)) {
    renderer.notice("usage: /skill save <name> [description] (name must match [A-Za-z0-9._-]+)");
    return;
  }

  let getLastVerifiedCodemodeScript:
    | ((sessionId?: string) => unknown | Promise<unknown>)
    | undefined;
  try {
    const codemodeSpec = "../tools/codemode";
    const codemodeMod = (await import(codemodeSpec)) as Record<string, unknown>;
    if (typeof codemodeMod.getLastVerifiedCodemodeScript === "function") {
      getLastVerifiedCodemodeScript = codemodeMod.getLastVerifiedCodemodeScript as (
        sessionId?: string,
      ) => unknown | Promise<unknown>;
    }
  } catch {
    /* Track A3 codemode module not yet present */
  }

  if (typeof getLastVerifiedCodemodeScript !== "function") {
    renderer.notice("skill save unavailable: verified code_mode script provider is not enabled in this build");
    return;
  }

  let saveVerifiedSkill:
    | ((
        ws: string,
        opts: { name: string; description: string; script: string; language?: string },
      ) => unknown | Promise<unknown>)
    | undefined;
  try {
    const skillsSpec = "../core/skills";
    const skillsMod = (await import(skillsSpec)) as Record<string, unknown>;
    if (typeof skillsMod.saveVerifiedSkill === "function") {
      saveVerifiedSkill = skillsMod.saveVerifiedSkill as (
        ws: string,
        opts: { name: string; description: string; script: string; language?: string },
      ) => unknown | Promise<unknown>;
    }
  } catch {
    /* ignore */
  }

  if (typeof saveVerifiedSkill !== "function") {
    renderer.notice("skill save unavailable: saveVerifiedSkill is not supported in this build");
    return;
  }

  try {
    const lastScript = await getLastVerifiedCodemodeScript(runtime.sessionId);
    if (!lastScript) {
      renderer.notice("no verified code_mode script found for this session — run code_mode first");
      return;
    }
    const scriptBody =
      typeof lastScript === "string"
        ? lastScript
        : typeof (lastScript as { script?: unknown }).script === "string"
          ? ((lastScript as { script: string }).script)
          : typeof (lastScript as { code?: unknown }).code === "string"
            ? ((lastScript as { code: string }).code)
            : "";
    if (scriptBody.trim() === "") {
      renderer.notice("no verified code_mode script body available to save");
      return;
    }
    const saved = await saveVerifiedSkill(workspace, {
      name,
      description: description || `Verified code_mode skill ${name}`,
      script: scriptBody,
    });
    const savedPath =
      saved && typeof saved === "object" && typeof (saved as { skillMdPath?: unknown }).skillMdPath === "string"
        ? ` (${(saved as { skillMdPath: string }).skillMdPath})`
        : "";
    renderer.notice(`saved verified skill /${name}${savedPath}`);
  } catch (err) {
    renderer.notice(`could not save skill /${name}: ${errorMessage(err)}`);
  }
}

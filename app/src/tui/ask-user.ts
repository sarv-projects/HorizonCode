/**
 * ask-user.ts — TUI path for `builtin.ask_user` (ui.present).
 */

import type { AskUserHandler, AskUserOption, AskUserRequest } from "../contracts";
import * as core from "../core";
import type { ApprovalUi } from "./approval";
import { bold, cyan, dim, sanitizeText } from "./style";

const CONTEXT_MAX = 4096;

function escapeInvisible(s: string): string {
  return sanitizeText(
    s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
      return `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
    }),
  );
}

function formatOptionLines(options: AskUserOption[]): string[] {
  return options.flatMap((opt, i) => {
    const mark = opt.recommended === true ? " *" : "";
    const head = `${i + 1}. ${escapeInvisible(opt.label)}${mark}`;
    return opt.description !== undefined && opt.description.trim() !== ""
      ? [head, dim(`   ${escapeInvisible(opt.description)}`)]
      : [head];
  });
}

function pickByIndex(answer: string, options: AskUserOption[]): string | undefined {
  const t = answer.trim();
  if (t === "") return undefined;
  const n = Number.parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1 && n <= options.length) {
    return options[n - 1]!.label;
  }
  const lower = t.toLowerCase();
  const exact = options.find((o) => o.label.toLowerCase() === lower);
  if (exact !== undefined) return exact.label;
  return undefined;
}

/** Register with the runtime; uses the same chat surface as approvals. */
export function createAskUserHandler(ui: ApprovalUi): AskUserHandler {
  return async (req: AskUserRequest) => {
    if (!ui.interactive) {
      throw new Error("no interactive user attached");
    }
    const question = escapeInvisible(sanitizeText(req.question)).trim();
    if (question === "") throw new Error("empty question");
    const ctx =
      req.context !== undefined && req.context.trim() !== ""
        ? escapeInvisible(
            sanitizeText(req.context.length > CONTEXT_MAX ? req.context.slice(0, CONTEXT_MAX) : req.context),
          )
        : "";
    const r = ui.renderer;
    r.ensureLineStart();
    const lines = [bold(cyan("Question")), "", question];
    if (ctx !== "") {
      lines.push("", dim(ctx));
    }
    const options = req.options ?? [];
    if (options.length > 0) {
      lines.push("", ...formatOptionLines(options));
      if (req.defaultOption !== undefined) {
        lines.push("", dim(`(Enter alone → ${escapeInvisible(req.defaultOption)})`));
      }
      lines.push("", dim("Reply with a number, the option label, or your own text."));
    } else {
      lines.push("", dim("Type your answer."));
    }
    r.write("\n" + lines.join("\n") + "\n");

    let answer = "";
    try {
      answer = await ui.ask(dim(" › ") + bold(cyan("\u276f ")));
    } catch {
      answer = "";
    }
    const trimmed = String(answer ?? "").trim();
    if (trimmed === "") {
      if (options.length > 0 && req.defaultOption !== undefined) return req.defaultOption;
      throw new Error("no answer from user");
    }
    if (options.length > 0) {
      const picked = pickByIndex(trimmed, options);
      if (picked !== undefined) return picked;
    }
    return trimmed.length > 2048 ? `${trimmed.slice(0, 2048)}` : trimmed;
  };
}

type CoreAskUserExtra = {
  setAskUserHandler?: (handler: import("../contracts").AskUserHandler | undefined) => void;
  default?: { setAskUserHandler?: (handler: import("../contracts").AskUserHandler | undefined) => void };
};

/** Hand the ask_user handler to the core runtime. */
export function installAskUserHandler(ui: ApprovalUi): boolean {
  const mod = core as unknown as CoreAskUserExtra;
  const fn =
    typeof mod?.setAskUserHandler === "function" ? mod.setAskUserHandler : mod?.default?.setAskUserHandler;
  if (typeof fn !== "function") return false;
  try {
    fn(createAskUserHandler(ui));
    return true;
  } catch {
    return false;
  }
}
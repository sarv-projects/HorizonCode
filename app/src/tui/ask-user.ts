/**
 * ask-user.ts — TUI path for `builtin.ask_user` (ui.present).
 */

import type { AskUserHandler, AskUserOption, AskUserRequest } from "../contracts";
import * as core from "../core";
import type { ApprovalUi } from "./approval";
import { emitOsc7501 } from "./osc7501";
import { bold, cyan, dim, sanitizeText, visibleWidth, wrapText } from "./style";

const CONTEXT_MAX = 4096;

function escapeInvisible(s: string): string {
  return sanitizeText(
    s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\u061c\ufeff]/g, (c) => {
      return `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
    }),
  );
}

function wrapBoxLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  const w = Math.max(12, Math.floor(width));
  for (const raw of lines) {
    const parts = raw.replace(/\r\n?/g, "\n").split("\n");
    for (const part of parts) {
      if (part === "") {
        out.push("");
        continue;
      }
      if (visibleWidth(part) <= w) {
        out.push(part);
      } else {
        for (const wrapped of wrapText(sanitizeText(part), w)) {
          out.push(wrapped);
        }
      }
    }
  }
  return out;
}

/**
 * Format a dedicated clarify frame (box) around an AskUser request.
 */
export function formatClarifyFrame(req: AskUserRequest, maxCols = 76): string {
  const question = escapeInvisible(sanitizeText(req.question)).trim();
  const ctx =
    req.context !== undefined && req.context.trim() !== ""
      ? escapeInvisible(sanitizeText(req.context.length > CONTEXT_MAX ? req.context.slice(0, CONTEXT_MAX) : req.context))
      : "";

  const options = req.options ?? [];
  const contentWidth = Math.max(48, Math.min(maxCols - 4, 72));

  const contentLines: string[] = [
    bold(cyan("Question:")) + " " + question,
  ];

  if (ctx !== "") {
    contentLines.push(dim("Context:") + " " + dim(ctx));
  }

  if (options.length > 0) {
    contentLines.push("");
    contentLines.push(bold("Options:"));
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const mark = opt.recommended === true ? " " + cyan("(Recommended)") : "";
      contentLines.push(`  ${i + 1}. ${escapeInvisible(opt.label)}${mark}`);
      if (opt.description && opt.description.trim() !== "") {
        contentLines.push(dim(`     ${escapeInvisible(opt.description)}`));
      }
    }
  }

  contentLines.push("");
  const hintParts: string[] = [];
  if (req.defaultOption !== undefined) {
    hintParts.push(`Enter: default (${escapeInvisible(req.defaultOption)})`);
  }
  if (options.length > 0) {
    if (req.multiSelect === true) {
      hintParts.push("1-N: comma-separated numbers");
    } else {
      hintParts.push("1-N: select option number");
    }
  }
  if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
    hintParts.push(`timeout: ${Math.round(req.timeoutMs / 1000)}s`);
  }
  if (hintParts.length > 0) {
    let cur = "";
    for (const part of hintParts) {
      const candidate = cur === "" ? part : `${cur} | ${part}`;
      if (cur !== "" && visibleWidth(candidate) > contentWidth) {
        contentLines.push(dim(cur));
        cur = part;
      } else {
        cur = candidate;
      }
    }
    if (cur !== "") contentLines.push(dim(cur));
  }

  const title = " Clarification Requested ";
  const topBarLength = Math.max(0, contentWidth + 2 - visibleWidth(title) - 2);
  const topBorder = "┌─" + bold(cyan(title)) + "─".repeat(topBarLength) + "┐";
  const bottomBorder = "└" + "─".repeat(contentWidth + 2) + "┘";

  const rows = [topBorder];
  for (const line of wrapBoxLines(contentLines, contentWidth)) {
    const vWidth = visibleWidth(line);
    const pad = " ".repeat(Math.max(0, contentWidth - vWidth));
    rows.push(`│ ${line}${pad} │`);
  }
  rows.push(bottomBorder);

  return rows.join("\n");
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
export function createAskUserHandler(
  ui: ApprovalUi,
  opts?: { signal?: AbortSignal },
): AskUserHandler {
  return async (req: AskUserRequest) => {
    if (!ui.interactive) {
      throw new Error("no interactive user attached");
    }
    const question = escapeInvisible(sanitizeText(req.question)).trim();
    if (question === "") throw new Error("empty question");
    const externalSignal = (req as AskUserRequest & { signal?: AbortSignal }).signal ?? opts?.signal;
    if (externalSignal?.aborted) {
      throw new Error("aborted waiting for user input");
    }
    const options = req.options ?? [];
    const r = ui.renderer;
    r.ensureLineStart();
    const frame = formatClarifyFrame(req);
    r.write("\n" + frame + "\n");
    emitOsc7501((c) => process.stdout.write(c), "blocked", { kind: "question" });

    const ac = new AbortController();
    const onExternalAbort = (): void => ac.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let answer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
        let timedOut = false;
        const timeoutPromise = new Promise<string>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("timeout"));
            ac.abort();
          }, req.timeoutMs);
        });
        try {
          answer = await Promise.race([
            ui.ask(dim(" › ") + bold(cyan("\u276f ")), { signal: ac.signal }),
            timeoutPromise,
          ]);
          if (timedOut) {
            if (req.defaultOption !== undefined) return req.defaultOption;
            throw new Error("timed out waiting for user input");
          }
        } catch (err) {
          if (timedOut) {
            if (req.defaultOption !== undefined) return req.defaultOption;
            throw new Error("timed out waiting for user input");
          }
          throw err;
        }
      } else {
        answer = await ui.ask(dim(" › ") + bold(cyan("\u276f ")), { signal: ac.signal });
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("timed out")) throw e;
      answer = "";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (!ac.signal.aborted) ac.abort();
      emitOsc7501((c) => process.stdout.write(c), "working");
    }
    if (externalSignal?.aborted) {
      throw new Error("aborted waiting for user input");
    }
    const trimmed = String(answer ?? "").trim();
    if (trimmed === "") {
      if (req.defaultOption !== undefined) return req.defaultOption;
      throw new Error("no answer from user");
    }
    if (options.length > 0) {
      if (req.multiSelect === true) {
        const parts = trimmed.split(/[,;\n]+/).map((p) => p.trim()).filter((p) => p !== "");
        const pickedList: string[] = [];
        for (const part of parts) {
          const single = pickByIndex(part, options);
          if (single !== undefined && !pickedList.includes(single)) {
            pickedList.push(single);
          }
        }
        if (pickedList.length > 0) return pickedList.join(", ");
      }
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
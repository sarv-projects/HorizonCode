/**
 * `ask_user` — structured question to the human (ui.present; session-state admission).
 */

import type { AskUserOption, AskUserRequest, Tool, ToolContext, ToolResult } from "../contracts";

const QUESTION_MAX = 2048;
const CONTEXT_MAX = 4096;
const OPTION_MAX = 8;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function parseOptions(raw: unknown): AskUserOption[] | string {
  if (!Array.isArray(raw)) return "options must be an array";
  const parsed: AskUserOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label === "") return "each option must be a non-empty string or {label}";
      parsed.push({ label });
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label.trim() : "";
      if (label === "") return "each object option needs a non-empty label";
      const description =
        typeof (item as { description?: unknown }).description === "string" &&
        (item as { description: string }).description.trim() !== ""
          ? (item as { description: string }).description.trim()
          : undefined;
      const recommended = (item as { recommended?: unknown }).recommended === true;
      parsed.push({ label, ...(description !== undefined ? { description } : {}), ...(recommended ? { recommended } : {}) });
      continue;
    }
    return "each option must be a non-empty string or {label}";
  }
  if (parsed.length < 2 || parsed.length > OPTION_MAX) {
    return `options must have 2–${OPTION_MAX} entries when set`;
  }
  return parsed;
}

function optionLabels(options: AskUserOption[]): string[] {
  return options.map((o) => o.label);
}

function formatApprovalDetail(req: AskUserRequest): string {
  const lines = [req.question];
  if (req.context !== undefined && req.context.trim() !== "") {
    lines.push("", req.context.trim());
  }
  if (req.options !== undefined && req.options.length > 0) {
    lines.push("");
    req.options.forEach((opt, i) => {
      const mark = opt.recommended === true ? " *" : "";
      lines.push(`${i + 1}. ${opt.label}${mark}`);
      if (opt.description !== undefined && opt.description.trim() !== "") {
        lines.push(`   ${opt.description.trim()}`);
      }
    });
    const pick = req.defaultOption ?? req.options[0]?.label;
    if (pick !== undefined) lines.push(`(approval yes → ${pick})`);
  }
  return lines.join("\n");
}

export const askUserTool: Tool = {
  name: "ask_user",
  concurrencyClass: "exclusive",
  description:
    "Ask the human a question and block until answered. Use when you need a decision only the user can make; do not guess.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to present (≤ 2 KiB)." },
      context: { type: "string", description: "Optional background (≤ 4 KiB)." },
      options: {
        type: "array",
        description: "Optional choices (2–8): plain strings or {label, description?, recommended?}.",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
                recommended: { type: "boolean" },
              },
              required: ["label"],
            },
          ],
        },
      },
      default: {
        type: "string",
        description: "Default answer when the user accepts without picking (optional).",
      },
    },
    required: ["question"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (question === "") return fail("question is required");
    if (question.length > QUESTION_MAX) return fail(`question must be at most ${QUESTION_MAX} characters`);

    let context: string | undefined;
    if (args.context !== undefined) {
      if (typeof args.context !== "string") return fail("context must be a string");
      const c = args.context.trim();
      if (c.length > CONTEXT_MAX) return fail(`context must be at most ${CONTEXT_MAX} characters`);
      context = c !== "" ? c : undefined;
    }

    let options: AskUserOption[] | undefined;
    if (args.options !== undefined) {
      const parsed = parseOptions(args.options);
      if (typeof parsed === "string") return fail(parsed);
      options = parsed;
    }

    const defaultOption =
      typeof args.default === "string" && args.default.trim() !== "" ? args.default.trim() : undefined;
    if (defaultOption !== undefined && options !== undefined && !optionLabels(options).includes(defaultOption)) {
      return fail("default must be one of the listed options");
    }

    const req: AskUserRequest = { question, options, context, defaultOption };

    if (ctx.askUser !== undefined) {
      try {
        const answer = (await ctx.askUser(req)).trim();
        if (answer === "") return fail("no answer from user");
        return { ok: true, output: answer };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`ask_user failed: ${message}`);
      }
    }

    if (options === undefined) {
      return fail("no askUser handler configured and no options for approve fallback");
    }

    const ok = await ctx.approve({
      title: "Question",
      detail: formatApprovalDetail(req),
      kind: "other",
      tool: "ask_user",
    });
    if (!ok) return fail("declined by user");
    const picked = defaultOption ?? options[0]!.label;
    return { ok: true, output: picked };
  },
};
/**
 * commit.ts - `hzcode commit` helpers (forgecode take T-16).
 *
 * The staged diff is captured with git (argv, no shell), turned into a commit
 * message by one ordinary model turn (diff plus an optional capped recent
 * user/assistant excerpt from the latest workspace session), and the commit
 * itself is a `shell.exec` that goes through the guard like any model-issued
 * command. Nothing here runs git commit.
 *
 * Conventional Commits subject enforcement (E-3 reduced; ruling 475) adapts
 * aider's `commit_system` type list and `type(scope): subject` shape.
 * Weak-model-first with token/context-limit fallback (E-3 reduced; ruling 480)
 * adapts aider `commit_message_models()` / `GitRepo.get_commit_message`: try
 * `HZ_WEAK_MODEL` first, skip or fall through when the prompt will not fit or
 * the provider reports a context/token limit, then the main model.
 */

import { spawnSync } from "node:child_process";
import type { ProviderFailureCode } from "../contracts";
import { estimateTokens } from "./output-budget";
import { SessionStore } from "./session";

/** Largest diff handed to the model; the rest is dropped with a note. */
export const COMMIT_DIFF_CAP = 24_000;

/** Largest conversation excerpt handed to the model (E-3 reduced; ruling 459). */
export const COMMIT_CONVERSATION_CAP = 4_000;

/** Subject line budget (aider / Conventional Commits guidance). */
export const COMMIT_SUBJECT_MAX = 72;

/**
 * Aider `commit_system` types (repo_take/aider/aider/prompts.py).
 * Unknown types that still match `type(scope): subject` are kept lowercased.
 */
export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "build",
  "chore",
  "ci",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
] as const;

export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number];

const CONVENTIONAL_TYPE_SET: ReadonlySet<string> = new Set(CONVENTIONAL_COMMIT_TYPES);

/** `type(scope)!: description` — scope and `!` optional. */
const CONVENTIONAL_SUBJECT_RE =
  /^([A-Za-z]+)(?:\(([A-Za-z0-9._/-]*)\))?(!)?\s*:\s*(.+)$/;

export type ConventionalCommitSubject = {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
};

/** Minimal turn shape for commit-message conversation excerpts. */
export type CommitConversationTurn = {
  role: string;
  content?: string | null;
};

export function stagedDiff(workspace: string): { diff: string; truncated: boolean } | { error: string } {
  const res = spawnSync("git", ["diff", "--staged", "--no-color", "--no-ext-diff"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { error: (res.stderr || res.error?.message || "git diff --staged failed").trim() };
  }
  const text = res.stdout ?? "";
  if (text.length <= COMMIT_DIFF_CAP) return { diff: text, truncated: false };
  return { diff: text.slice(0, COMMIT_DIFF_CAP), truncated: true };
}

/**
 * Format a capped recent user/assistant excerpt for the commit-message prompt.
 * Keeps the most recent turns that fit; skips system/tool rows. Empty when none.
 */
export function formatCommitConversationExcerpt(
  messages: readonly CommitConversationTurn[],
  cap: number = COMMIT_CONVERSATION_CAP,
): string {
  if (cap <= 0) return "";
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = String(msg.content ?? "").trim();
    if (text === "") continue;
    turns.push({ role: msg.role, text });
  }
  if (turns.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const line = `${turn.role}: ${turn.text}`;
    if (kept.length === 0 && line.length > cap) {
      kept.push(line.slice(0, Math.max(0, cap)));
      truncated = true;
      used = cap;
      break;
    }
    const sep = kept.length > 0 ? 1 : 0;
    if (used + sep + line.length > cap) {
      truncated = true;
      break;
    }
    kept.push(line);
    used += sep + line.length;
  }
  kept.reverse();
  const body = kept.join("\n");
  return truncated ? `${body}\n[conversation truncated]` : body;
}

/**
 * Load a capped user/assistant excerpt from the workspace's latest session.
 * Opens the session store briefly and closes it; safe before `createRuntime`
 * (which may start a fresh session that would otherwise become "latest").
 */
export function latestCommitConversationExcerpt(
  workspace: string,
  cap: number = COMMIT_CONVERSATION_CAP,
): string {
  const store = new SessionStore(workspace);
  try {
    const latest = store.latestSession();
    if (!latest) return "";
    return formatCommitConversationExcerpt(store.history(latest.id), cap);
  } finally {
    store.close();
  }
}

export function commitPrompt(
  diff: string,
  truncated: boolean,
  context: string,
  conversationExcerpt = "",
): string {
  const types = CONVENTIONAL_COMMIT_TYPES.join(", ");
  const parts = [
    "Write a git commit message for the staged diff below.",
    `Follow Conventional Commits: type(scope): subject — types: ${types} (scope optional; use type!: subject for a breaking change).`,
    `Reply with only the message: a subject line of at most ${COMMIT_SUBJECT_MAX} characters in the imperative mood, then, if useful, a blank line and a short body.`,
    "No code fences, no quotes, no preamble. Do not call any tool.",
  ];
  if (context.trim() !== "") parts.push(`Extra context from the author: ${context.trim()}`);
  if (conversationExcerpt.trim() !== "") {
    parts.push("Recent conversation (intent only; the staged diff is authoritative):");
    parts.push(conversationExcerpt.trim());
  }
  parts.push("");
  parts.push("```diff");
  parts.push(diff);
  if (truncated) parts.push("[diff truncated]");
  parts.push("```");
  return parts.join("\n");
}

/** Parse a Conventional Commits subject; null when the line is not shaped. */
export function parseConventionalCommitSubject(subject: string): ConventionalCommitSubject | null {
  const line = String(subject ?? "").trim();
  if (line === "") return null;
  const m = CONVENTIONAL_SUBJECT_RE.exec(line);
  if (!m) return null;
  const description = (m[4] ?? "").trim();
  if (description === "") return null;
  return {
    type: (m[1] ?? "").toLowerCase(),
    scope: m[2] !== undefined ? m[2] : null,
    breaking: m[3] === "!",
    description,
  };
}

/** True when the subject uses a known Conventional Commits type. */
export function isConventionalCommitSubject(subject: string): boolean {
  const parsed = parseConventionalCommitSubject(subject);
  return parsed !== null && CONVENTIONAL_TYPE_SET.has(parsed.type);
}

/** Build `type(scope)!: description`, truncating so the subject fits COMMIT_SUBJECT_MAX. */
export function formatConventionalCommitSubject(
  type: string,
  description: string,
  opts?: { scope?: string | null; breaking?: boolean },
): string {
  const t = String(type ?? "").trim().toLowerCase() || "chore";
  const scope = opts?.scope?.trim() ?? "";
  const bang = opts?.breaking ? "!" : "";
  const prefix = scope !== "" ? `${t}(${scope})${bang}: ` : `${t}${bang}: `;
  let desc = String(description ?? "").trim().replace(/\s+/g, " ");
  if (desc === "") desc = "update";
  const maxDesc = Math.max(1, COMMIT_SUBJECT_MAX - prefix.length);
  if (desc.length > maxDesc) desc = desc.slice(0, maxDesc).trimEnd();
  return prefix + desc;
}

/**
 * Validate/normalize the first line to `type(scope): subject`.
 * Known or conventional-shaped types are lowercased and re-spaced; bare
 * subjects (and noise like `Commit: …`) get a `chore:` prefix. Body preserved.
 */
export function normalizeConventionalCommitMessage(message: string): string {
  const text = String(message ?? "").replace(/\r\n/g, "\n").trim();
  if (text === "") return "";

  const nl = text.indexOf("\n");
  let subject = (nl === -1 ? text : text.slice(0, nl)).trim();
  const after = nl === -1 ? "" : text.slice(nl + 1);
  const body = after.replace(/^\n+/, "").trimEnd();

  // Drop prose wrappers models often emit before a real subject.
  subject = subject.replace(/^(commit(\s+message)?|message)\s*:\s*/i, "").trim() || subject;

  const parsed = parseConventionalCommitSubject(subject);
  const normalized = parsed
    ? formatConventionalCommitSubject(parsed.type, parsed.description, {
        scope: parsed.scope,
        breaking: parsed.breaking,
      })
    : formatConventionalCommitSubject("chore", subject);

  if (body === "") return normalized;
  return `${normalized}\n\n${body}`;
}

/** Strip fences and quotes a model tends to wrap a message in. */
export function cleanCommitMessage(raw: string): string {
  let text = String(raw ?? "").trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  return text.replace(/\r\n/g, "\n");
}

export function withReceiptTrailer(message: string, head: string | undefined): string {
  if (head === undefined || head === "") return message;
  return `${message}\n\nHZ-Receipt: ${head}`;
}

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, `'\\''`) + "'";
}

export function commitCommand(message: string): string {
  return `git commit -m ${shellQuote(message)}`;
}

/* -------------------- E-3 weak-model-first (ruling 480) -------------------- */

/** Env key for the cheaper commit-message model (aider `--weak-model` spirit). */
export const COMMIT_WEAK_MODEL_ENV = "HZ_WEAK_MODEL";

/**
 * Aider `Model.commit_message_models()`: `[weak, main]`, deduped when equal or
 * weak is unset. Empty main yields an empty chain.
 */
export function commitMessageModels(mainModel: string, weakModel?: string | null): string[] {
  const main = String(mainModel ?? "").trim();
  if (main === "") return [];
  const weak = String(weakModel ?? "").trim();
  if (weak === "" || weak === main) return [main];
  return [weak, main];
}

/** Resolve optional weak model from env (`HZ_WEAK_MODEL`); undefined when unset. */
export function resolveCommitWeakModel(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  const raw = String(env[COMMIT_WEAK_MODEL_ENV] ?? "").trim();
  return raw !== "" ? raw : undefined;
}

/**
 * Whether the prompt fits a known input window (aider pre-send skip).
 * Unknown / non-positive window → try the model (do not skip).
 */
export function commitPromptFitsWindow(prompt: string, windowTokens: number | undefined): boolean {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return true;
  return estimateTokens(prompt) <= Math.floor(windowTokens);
}

const COMMIT_TOKEN_LIMIT_RE =
  /context.?window|maximum.?context|prompt.?too.?long|input.?too.?long|too.?many.?tokens|max(?:imum)?_?(?:prompt|context|input)_?tokens|token.?limit|context.?length/i;

/** True when a failed commit-message attempt should fall through to the next model. */
export function isCommitTokenLimitFailure(opts: {
  failureCode?: ProviderFailureCode | string | null;
  errorText?: string | null;
  exitDetail?: string | null;
}): boolean {
  if (opts.failureCode === "CONTEXT_WINDOW_EXCEEDED") return true;
  const text = String(opts.errorText ?? "");
  if (text !== "" && COMMIT_TOKEN_LIMIT_RE.test(text)) return true;
  // provider_error alone is not enough — only when the message looks like a limit
  if (opts.exitDetail === "provider_error" && text !== "" && COMMIT_TOKEN_LIMIT_RE.test(text)) return true;
  return false;
}

export type CommitModelAttemptResult = {
  text: string;
  aborted?: boolean;
  failureCode?: ProviderFailureCode | string;
  errorText?: string;
  exitDetail?: string;
};

export type CommitMessageModelOk = {
  message: string;
  model: string;
  /** Models skipped because the prompt would not fit their window. */
  skipped: string[];
  /** Models attempted that hit a token/context limit before success. */
  failedTokenLimit: string[];
};

export type CommitMessageModelErr = {
  error: string;
  tried: string[];
  skipped: string[];
  failedTokenLimit: string[];
};

/**
 * Walk `models` weak-first: skip when the prompt will not fit a known window;
 * on token/context-limit failure try the next model; stop on the first usable
 * Conventional Commits message (aider `get_commit_message` loop, reduced).
 */
export async function generateCommitMessageWithModelFallback(args: {
  models: readonly string[];
  prompt: string;
  /** Optional input-window lookup; missing/≤0 → always attempt. */
  windowForModel?: (model: string) => number | undefined;
  attempt: (model: string) => Promise<CommitModelAttemptResult>;
}): Promise<CommitMessageModelOk | CommitMessageModelErr> {
  const models = (args.models ?? []).map((m) => String(m ?? "").trim()).filter((m) => m !== "");
  const skipped: string[] = [];
  const failedTokenLimit: string[] = [];
  const tried: string[] = [];

  if (models.length === 0) {
    return { error: "no model configured for commit message", tried, skipped, failedTokenLimit };
  }

  for (const model of models) {
    const window = args.windowForModel?.(model);
    if (!commitPromptFitsWindow(args.prompt, window)) {
      skipped.push(model);
      continue;
    }
    tried.push(model);
    let result: CommitModelAttemptResult;
    try {
      result = await args.attempt(model);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      if (isCommitTokenLimitFailure({ errorText })) {
        failedTokenLimit.push(model);
        continue;
      }
      return {
        error: errorText || "commit message model call failed",
        tried,
        skipped,
        failedTokenLimit,
      };
    }

    const message = normalizeConventionalCommitMessage(cleanCommitMessage(result.text));
    if (!result.aborted && message !== "") {
      return { message, model, skipped, failedTokenLimit };
    }

    if (
      isCommitTokenLimitFailure({
        failureCode: result.failureCode,
        errorText: result.errorText,
        exitDetail: result.exitDetail,
      })
    ) {
      failedTokenLimit.push(model);
      continue;
    }

    // Empty / aborted without a token-limit signal: try the next model in the
    // chain (weak may simply refuse); if this was the last, surface failure.
  }

  const parts = [
    "no message was produced",
    tried.length > 0 ? `tried ${tried.join(" → ")}` : null,
    skipped.length > 0 ? `skipped (token window) ${skipped.join(", ")}` : null,
  ].filter(Boolean);
  return { error: parts.join("; "), tried, skipped, failedTokenLimit };
}

/** Human-readable notices for skip / token-limit fallback (stderr / TUI). */
export function formatCommitModelFallbackNotices(result: CommitMessageModelOk | CommitMessageModelErr): string[] {
  const notices: string[] = [];
  for (const model of result.skipped) {
    notices.push(`commit: skipped model ${model} (prompt exceeds input token window)`);
  }
  for (const model of result.failedTokenLimit) {
    notices.push(`commit: model ${model} hit token/context limit; trying next`);
  }
  if ("message" in result && (result.skipped.length > 0 || result.failedTokenLimit.length > 0)) {
    notices.push(`commit: message drafted with ${result.model}`);
  }
  return notices;
}

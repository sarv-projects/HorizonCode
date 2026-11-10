/**
 * commit.ts - `hzcode commit` helpers (forgecode take T-16).
 *
 * The staged diff is captured with git (argv, no shell), turned into a commit
 * message by one ordinary model turn, and the commit itself is a `shell.exec`
 * that goes through the guard like any model-issued command. Nothing here
 * runs git commit.
 */

import { spawnSync } from "node:child_process";

/** Largest diff handed to the model; the rest is dropped with a note. */
export const COMMIT_DIFF_CAP = 24_000;

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

export function commitPrompt(diff: string, truncated: boolean, context: string): string {
  return [
    "Write a git commit message for the staged diff below.",
    "Reply with only the message: a subject line of at most 72 characters in the imperative mood, then, if useful, a blank line and a short body.",
    "No code fences, no quotes, no preamble. Do not call any tool.",
    context.trim() !== "" ? `Extra context from the author: ${context.trim()}` : "",
    "",
    "```diff",
    diff,
    truncated ? "[diff truncated]" : "",
    "```",
  ]
    .filter((line, i) => line !== "" || i > 3)
    .join("\n");
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

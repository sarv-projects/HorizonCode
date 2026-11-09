/**
 * print.ts — one non-interactive turn (`hzcode -p "prompt"`).
 *
 * Claude Code `-p --output-format json|stream-json` and `codex exec --json`
 * are the references. The prompt is sent as ONE turn and the process exits
 * with the canonical code from exitCodeFor (docs/14 §3.2; never restated
 * here). Output formats:
 *
 *   text         the final assistant text and a newline (default)
 *   json         ONE result object at the end
 *   stream-json  one RuntimeEvent per line (NDJSON), then the result object
 *
 * stdout carries ONLY the requested format; notices go to stderr. Approvals
 * stay fail-closed: nothing here prompts, and a guard that needs a human gets
 * a deny (the approval UI is built non-interactive by main.ts).
 */

import type { RunExit, Runtime, RuntimeEvent } from "../contracts";
import { exitCodeFor } from "../core/loop";
import { errorMessage, sanitizeText } from "./style";

export type PrintFormat = "text" | "json" | "stream-json";

export const PRINT_FORMATS: readonly PrintFormat[] = ["text", "json", "stream-json"];

export interface PrintOptions {
  runtime: Runtime;
  prompt: string;
  format: PrintFormat;
  /** where stdout lines go (default: process.stdout) */
  write?: (chunk: string) => void;
}

/** The final object of `json` and the last line of `stream-json`. */
export interface PrintResult {
  type: "result";
  result: string;
  sessionId: string;
  /** the run outcome plus the process exit code it maps to */
  exit: { terminal: RunExit["terminal"]; detail?: string; code: number };
  /** the harness's last context estimate for the run; null if none was emitted */
  usage: { model: string; contextWindow: number; estimatedInputTokens: number } | null;
  /** distinct top-level tool calls */
  toolCalls: number;
  /** workspace-relative paths named by the turn diffs, in first-changed order */
  changedFiles: string[];
}

/** Paths from a unified diff body (`+++ b/x`, or `--- a/x` when the file was removed). */
export function filesInDiff(diff: string): string[] {
  const out: string[] = [];
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!line.startsWith("+++ ")) continue;
    let name = line.slice(4);
    if (name === "/dev/null") {
      const prev = i > 0 ? (lines[i - 1] as string) : "";
      if (!prev.startsWith("--- ")) continue;
      name = prev.slice(4);
    }
    name = name.replace(/^[ab]\//, "");
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

export async function runPrint(opts: PrintOptions): Promise<number> {
  const write = opts.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const calls = new Set<string>();
  const changed: string[] = [];
  let usage: PrintResult["usage"] = null;
  let lastExit: RunExit | undefined;
  let text = "";
  let signal: 130 | 143 | null = null;

  const onSigint = (): void => {
    signal = 130;
    try {
      opts.runtime.abort();
    } catch {
      /* nothing in flight */
    }
  };
  const onSigterm = (): void => {
    signal = 143;
    try {
      opts.runtime.abort();
    } catch {
      /* nothing in flight */
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const onEvent = (ev: RuntimeEvent): void => {
    if (!ev) return;
    if (ev.type === "tool.card") calls.add(ev.callId);
    else if (ev.type === "turn.diff") {
      for (const f of filesInDiff(ev.diff)) if (!changed.includes(f)) changed.push(f);
    } else if (ev.type === "context.usage") {
      usage = { model: ev.model, contextWindow: ev.window, estimatedInputTokens: ev.estimatedInput };
    } else if (ev.type === "error") process.stderr.write(`hzcode: ${sanitizeText(ev.message)}\n`);
    if (opts.format === "stream-json") write(JSON.stringify(ev) + "\n");
  };

  try {
    const res = await opts.runtime.send(opts.prompt, { onEvent });
    text = res.text ?? "";
    lastExit = res.exit;
  } catch (err) {
    // A throw is an internal error, never a success.
    process.stderr.write(`hzcode: request failed: ${errorMessage(err)}\n`);
    lastExit = { terminal: "failed", detail: "internal_error" };
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const code = signal ?? exitCodeFor(lastExit);
  if (opts.format === "text") {
    write(text.endsWith("\n") || text === "" ? text : text + "\n");
  } else {
    const exit: PrintResult["exit"] = { terminal: lastExit?.terminal ?? "succeeded", code };
    if (lastExit?.detail !== undefined) exit.detail = lastExit.detail;
    const result: PrintResult = {
      type: "result",
      result: text,
      sessionId: opts.runtime.sessionId,
      exit,
      usage,
      toolCalls: calls.size,
      changedFiles: changed,
    };
    write(JSON.stringify(result) + "\n");
  }
  return code;
}

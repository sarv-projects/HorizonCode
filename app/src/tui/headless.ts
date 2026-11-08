/**
 * headless.ts — the non-interactive chat loop.
 *
 * Used when stdin is not a TTY (`echo "hi" | hzcode`, CI smoke tests, scripts).
 * Every line of stdin is one message: it is echoed, streamed back as plain text,
 * then the next line is read. Nothing here prompts, waits for a keypress or emits
 * an escape sequence — approvals fail closed with a printed notice.
 */

import readline from "node:readline";
import type { RunExit, Runtime } from "../contracts";
import { exitCodeFor } from "../core/loop";
import { createRenderer } from "./render";
import { bold, cyan, errorMessage, sanitizeText, setColorEnabled } from "./style";

const PROMPT = "\u276f ";

export interface HeadlessOptions {
  runtime: Runtime;
  /** a message typed on the command line, sent before stdin is read */
  initialMessage?: string;
}

/**
 * Exit codes come from the canonical table and from nowhere else (docs/14
 * §3.2, S16 — a surface MUST NOT restate it). This function used to be a
 * second, partial table that returned 0 for `failed`, so `hzcode | CI`
 * reported success for a run that had lost its audit trail or died on a
 * provider error. Any non-success terminal is now a non-zero exit.
 */

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  // Plain text only: stdout here is usually a pipe. Colour is forced off so a
  // capture of this output never contains control sequences.
  setColorEnabled(false);
  const renderer = createRenderer({ wrap: false });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  const pending: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const kick = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
  };

  rl.on("line", (line: string) => {
    pending.push(typeof line === "string" ? line : "");
    kick();
  });
  rl.on("close", () => {
    closed = true;
    kick();
  });
  rl.on("error", () => {
    closed = true;
    kick();
  });

  // There is no one to prompt here: an interrupted run must still leave cleanly.
  let lastExit: RunExit | undefined;
  let interruptSignal: "SIGINT" | null = null;
  let terminateSignal = false;
  const stop = (): void => {
    try {
      opts.runtime.abort();
    } catch {
      /* nothing to abort */
    }
    closed = true;
    kick();
    try {
      rl.close();
    } catch {
      /* already closed */
    }
  };
  const onSigint = (): void => {
    interruptSignal = "SIGINT";
    stop();
  };
  process.on("SIGINT", onSigint);
  // SIGTERM is its own code (143), not a success: a supervisor that stops a run
  // must be able to tell that it stopped it.
  const onSigterm = (): void => {
    terminateSignal = true;
    stop();
  };
  process.on("SIGTERM", onSigterm);

  const answer = async (raw: string): Promise<void> => {
    const text = sanitizeText(raw).trim();
    if (text === "") return;
    renderer.line(bold(cyan(PROMPT)) + text);
    try {
      const result = await opts.runtime.send(text, { onEvent: (ev) => renderer.handle(ev) });
      lastExit = result.exit ?? lastExit;
    } catch (err) {
      // A throw here is an internal error, not a success. Recording it keeps the
      // process exit honest when the failure never reached a run outcome.
      renderer.error(`request failed: ${errorMessage(err)}`);
      lastExit = { terminal: "failed", detail: "internal_error" };
    }
    renderer.ensureLineStart();
  };

  try {
    if (opts.initialMessage && opts.initialMessage.trim() !== "") await answer(opts.initialMessage);
    while (true) {
      const next = pending.shift();
      if (next !== undefined) {
        await answer(next);
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    try {
      rl.close();
    } catch {
      /* already closed */
    }
    renderer.ensureLineStart();
  }
  // A signal is more specific than the run outcome it produced.
  if (interruptSignal === "SIGINT") return 130;
  if (terminateSignal) return 143;
  return exitCodeFor(lastExit);
}

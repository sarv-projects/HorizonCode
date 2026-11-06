/**
 * headless.ts — the non-interactive chat loop.
 *
 * Used when stdin is not a TTY (`echo "hi" | hzcode`, CI smoke tests, scripts).
 * Every line of stdin is one message: it is echoed, streamed back as plain text,
 * then the next line is read. Nothing here prompts, waits for a keypress or emits
 * an escape sequence — approvals fail closed with a printed notice.
 */

import readline from "node:readline";
import type { Runtime } from "../contracts";
import { createRenderer } from "./render";
import { bold, cyan, errorMessage, sanitizeText, setColorEnabled } from "./style";

const PROMPT = "\u276f ";

export interface HeadlessOptions {
  runtime: Runtime;
  /** a message typed on the command line, sent before stdin is read */
  initialMessage?: string;
}

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
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const answer = async (raw: string): Promise<void> => {
    const text = sanitizeText(raw).trim();
    if (text === "") return;
    renderer.line(bold(cyan(PROMPT)) + text);
    try {
      await opts.runtime.send(text, { onEvent: (ev) => renderer.handle(ev) });
    } catch (err) {
      renderer.error(`request failed: ${errorMessage(err)}`);
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
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      rl.close();
    } catch {
      /* already closed */
    }
    renderer.ensureLineStart();
  }
  return 0;
}

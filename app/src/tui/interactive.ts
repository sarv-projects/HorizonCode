/**
 * interactive.ts — the chat loop.
 *
 * This is the product: a small banner, then a chat bar. The human types in plain
 * language, the answer streams into the scrollback above, and the bar comes back.
 * Slash commands, approvals and Ctrl+C exist only to keep that conversation
 * flowing without ever leaving the keyboard.
 */

import * as readline from "node:readline";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Runtime, ToolSpec } from "../contracts";
import * as toolsModule from "../tools";
import type { ApprovalUi } from "./approval";
import { printBanner, printGreeting } from "./banner";
import { createRenderer, type Renderer } from "./render";
import { bold, cyan, dim, errorMessage, sanitizeText, strip, terminalWidth, visibleWidth, wrapText } from "./style";

const PROMPT = "\u276f ";
const HISTORY_LIMIT = 500;

/** Extras the core runtime may or may not expose yet; each one is optional. */
type RuntimeWithExtras = Runtime & {
  newSession?: () => unknown;
  setModel?: (model: string) => unknown;
};

const toolSpecs = (toolsModule as { toolSpecs?: () => ToolSpec[] }).toolSpecs;

export interface InteractiveOptions {
  runtime: Runtime;
  workspace: string;
  version: string;
  /** shared approval hand-off (main.ts registers it with the core runtime) */
  ui: ApprovalUi;
  /** a message typed on the command line, sent as the first turn */
  initialMessage?: string;
}

/* ----------------------------- history file ----------------------------- */

function loadHistory(file: string, rl: readline.Interface): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* history is a convenience, never a reason to fail */
  }
  try {
    const recent = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-HISTORY_LIMIT);
    (rl as unknown as { history: string[] }).history = recent.reverse();
  } catch {
    /* first run: no history yet */
  }
}

function rememberHistory(file: string, text: string): void {
  try {
    appendFileSync(file, text.replace(/\s+/g, " ") + "\n");
    if (statSync(file).size > 512 * 1024) {
      const kept = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-HISTORY_LIMIT)
        .join("\n");
      writeFileSync(file, kept + "\n");
    }
  } catch {
    /* history is a convenience, never a reason to fail */
  }
}

/* ------------------------------ local text ------------------------------ */

function printWrapped(r: Renderer, text: string, style: (s: string) => string = (s) => s): void {
  const plain = strip(text);
  if (visibleWidth(plain) <= terminalWidth()) {
    r.line(text);
    return;
  }
  for (const part of wrapText(plain, terminalWidth())) r.line(style(part));
}

function printHelp(r: Renderer): void {
  const rows: Array<[string, string]> = [
    ["/help", "this list"],
    ["/new", "start a fresh session"],
    ["/model [name]", "show or switch the model"],
    ["/files", "tools the assistant can use"],
    ["/exit", "leave (Ctrl+D also works)"],
  ];
  const width = rows.reduce((max, [cmd]) => Math.max(max, cmd.length), 0) + 2;
  r.line(dim("Just type what you want in plain language \u2014 no flags needed."));
  r.line("");
  for (const [cmd, desc] of rows) r.line("  " + bold(cmd.padEnd(width)) + dim(desc));
  r.line("");
  printWrapped(r, "  Ctrl+C  stop the current answer (again to leave)   Ctrl+D  leave   \u2191/\u2193  earlier messages", dim);
}

function showTools(r: Renderer): void {
  let specs: ToolSpec[] = [];
  try {
    specs = toolSpecs ? toolSpecs() ?? [] : [];
  } catch {
    specs = [];
  }
  if (specs.length === 0) {
    r.notice("no tools are registered in this build yet");
    return;
  }
  const names = specs.map((spec) => spec?.name).filter((name): name is string => typeof name === "string" && name !== "");
  r.notice(`tools (${names.length}): ${names.join(", ")}`);
}

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const { workspace, ui } = opts;
  let runtime: Runtime = opts.runtime;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });

  let busy = false;
  let exiting = false;
  let abortRequested = false;
  let answerWaiter: ((line: string) => void) | null = null;
  let typedGuardArmed = false;
  const queued: string[] = [];
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const renderer: Renderer = createRenderer({
    wrap: true,
    beforeWrite: () => {
      // While an answer streams, anything typed into the chat bar stays on its own
      // line instead of being overwritten by the next chunk.
      if (!busy) {
        typedGuardArmed = false;
        return false;
      }
      const typed = String((rl as unknown as { line?: string }).line ?? "").length > 0;
      if (!typed) {
        typedGuardArmed = false;
        return false;
      }
      if (typedGuardArmed) return false;
      typedGuardArmed = true;
      process.stdout.write("\n");
      return true;
    },
  });

  // Wire the guard to this session: one line of the same chat bar is the answer.
  ui.renderer = renderer;
  ui.runtime = runtime;
  ui.ask = (question: string) =>
    new Promise<string>((resolve) => {
      answerWaiter = resolve;
      try {
        rl.setPrompt(question);
        rl.prompt();
      } catch {
        answerWaiter = null;
        resolve("");
      }
    });

  const historyFile = path.join(workspace, ".hzcode", "history");
  loadHistory(historyFile, rl);

  const out = (chunk: string): void => renderer.write(chunk);
  printBanner(
    { version: opts.version, model: runtime.model, provider: runtime.providerName, workspace, kernel: runtime.kernelMode },
    { out },
  );
  printGreeting({ out });

  const finish = (code: number): void => {
    if (exiting) return;
    exiting = true;
    try {
      runtime.abort();
    } catch {
      /* nothing in flight */
    }
    try {
      rl.close();
    } catch {
      /* already closed */
    }
    try {
      if (process.stdout.isTTY) process.stdout.write(busy ? "\n" : "\r\u001b[K\n");
    } catch {
      /* terminal went away */
    }
    resolveDone(code);
  };

  const showPrompt = (blank = false): void => {
    if (exiting) return;
    typedGuardArmed = false;
    if (blank) renderer.write("\n");
    try {
      rl.setPrompt(bold(cyan(PROMPT)));
      rl.prompt();
    } catch {
      /* terminal went away */
    }
  };

  const sendTurn = async (text: string): Promise<void> => {
    busy = true;
    abortRequested = false;
    typedGuardArmed = false;
    try {
      rl.setPrompt("");
    } catch {
      /* ignore */
    }
    renderer.ensureLineStart();
    try {
      await runtime.send(text, { onEvent: (ev) => renderer.handle(ev) });
    } catch (err) {
      renderer.error(`request failed: ${errorMessage(err)}`);
    } finally {
      busy = false;
      renderer.ensureLineStart();
    }
  };

  const drainQueue = async (): Promise<void> => {
    while (!exiting && queued.length > 0) {
      const next = queued.shift() as string;
      renderer.write(bold(cyan(PROMPT)) + sanitizeText(next) + "\n");
      await sendTurn(next);
    }
  };

  const tryNewSession = async (): Promise<Runtime | null> => {
    const candidate = (runtime as RuntimeWithExtras).newSession;
    if (typeof candidate !== "function") {
      renderer.notice("this session cannot be reset in place \u2014 leave with Ctrl+D and run hzcode again to start fresh");
      renderer.notice(`current session: ${runtime.sessionId}`);
      return null;
    }
    try {
      const next = (await Promise.resolve(candidate.call(runtime))) as Runtime | undefined;
      if (next && typeof next.send === "function") {
        renderer.notice(`new session: ${next.sessionId}`);
        printGreeting({ out });
        return next;
      }
      renderer.notice("the runtime did not hand back a new session");
      return null;
    } catch (err) {
      renderer.notice(`could not start a new session: ${errorMessage(err)}`);
      return null;
    }
  };

  const showOrSetModel = async (arg: string): Promise<void> => {
    if (arg === "") {
      renderer.notice(`model ${runtime.model} \u00b7 provider ${runtime.providerName}`);
      return;
    }
    const setModel = (runtime as RuntimeWithExtras).setModel;
    if (typeof setModel !== "function") {
      renderer.notice(`this session stays on ${runtime.model} \u2014 start with hzcode --model ${arg} to use another model`);
      return;
    }
    try {
      const applied = (await Promise.resolve(setModel.call(runtime, arg))) as unknown;
      renderer.notice(`model \u2192 ${typeof applied === "string" && applied !== "" ? applied : arg}`);
    } catch (err) {
      renderer.notice(`could not switch model: ${errorMessage(err)}`);
    }
  };

  const runSlash = async (text: string): Promise<void> => {
    const body = text.slice(1).trim();
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const arg = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();

    switch (name) {
      case "help":
      case "?":
        printHelp(renderer);
        break;
      case "exit":
      case "quit":
        finish(0);
        return;
      case "new": {
        const next = await tryNewSession();
        if (next) {
          runtime = next;
          ui.runtime = next;
        }
        break;
      }
      case "model":
        await showOrSetModel(arg);
        break;
      case "files":
        showTools(renderer);
        break;
      default:
        renderer.notice(`unknown command /${name} \u2014 try /help`);
        break;
    }
    showPrompt();
  };

  const handleUserLine = async (text: string): Promise<void> => {
    try {
      // Every line the human typed is worth remembering, commands included.
      rememberHistory(historyFile, text);
      if (text.startsWith("/")) {
        await runSlash(text);
        return;
      }
      if (busy) {
        queued.push(text);
        renderer.notice(`queued \u2014 it goes next (${queued.length} waiting)`);
        // No chat bar while an answer is streaming; it returns when the turn ends.
        return;
      }
      await sendTurn(text);
      await drainQueue();
      showPrompt(true);
    } catch (err) {
      busy = false;
      renderer.error(`something went wrong: ${errorMessage(err)}`);
      showPrompt();
    }
  };

  rl.on("line", (raw: string) => {
    if (answerWaiter) {
      const waiter = answerWaiter;
      answerWaiter = null;
      try {
        rl.setPrompt(bold(cyan(PROMPT)));
      } catch {
        /* ignore */
      }
      waiter(typeof raw === "string" ? raw : "");
      return;
    }
    const text = (typeof raw === "string" ? raw : "").trim();
    if (text === "") {
      showPrompt();
      return;
    }
    void handleUserLine(text);
  });

  rl.on("SIGINT", () => {
    if (busy) {
      if (answerWaiter) {
        const waiter = answerWaiter;
        answerWaiter = null;
        waiter("n");
      }
      if (abortRequested) return;
      abortRequested = true;
      try {
        runtime.abort();
      } catch {
        /* nothing in flight */
      }
      renderer.ensureLineStart();
      renderer.line(dim("(aborted)"));
      return;
    }
    finish(0);
  });

  rl.on("close", () => finish(0));

  const initial = (opts.initialMessage ?? "").trim();
  if (initial !== "") {
    renderer.line(bold(cyan(PROMPT)) + sanitizeText(initial));
    void handleUserLine(initial);
  } else {
    showPrompt();
  }

  return await done;
}

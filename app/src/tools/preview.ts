/**
 * `preview` — start, stop, or check a local preview server for the project.
 *
 * A preview is a long-running dev process owned by a chat session: `start`
 * resolves a command (explicit, else the package.json `dev`/`start` script),
 * asks the guard like any shell command would, spawns it detached with output
 * captured to a ring buffer, and scans that output for the URL to show the
 * human. `stop` kills the process group — previews never outlive their chat
 * session by accident, because stop is one message away.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../contracts";
import { newId } from "../contracts";

const OUTPUT_CAP = 4096;
const URL_WAIT_MS = 12_000;

interface PreviewEntry {
  id: string;
  pid: number;
  cmd: string;
  cwd: string;
  url?: string;
  startedAt: number;
  child: ChildProcess;
  output: string; // ring buffer, OUTPUT_CAP bytes
}

/** One registry per chat session; a session owns its own set of previews. */
const PREVIEWS = new Map<string, PreviewEntry[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(entry: PreviewEntry, chunk: string): void {
  entry.output = (entry.output + chunk).slice(-OUTPUT_CAP);
}

function tail(entry: PreviewEntry): string {
  const text = entry.output.trim();
  return text === "" ? "(no output yet)" : text.slice(-2000);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM then SIGKILL to the whole process group (child was spawned detached). */
async function killEntry(entry: PreviewEntry): Promise<void> {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-entry.pid, sig);
    } catch {
      try {
        entry.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  await sleep(400);
  if (alive(entry.pid)) {
    signal("SIGKILL");
    await sleep(100);
  }
}

function scanUrl(text: string, port: number | undefined): string | undefined {
  const urls = (text.match(/https?:\/\/[^\s"'\x1b<>)\]]+/g) ?? []).map((url) => url.replace(/[.,;:]+$/, ""));
  if (urls.length === 0) return undefined;
  if (port !== undefined) {
    const withPort = urls.find((url) => url.includes(`:${port}`));
    if (withPort) return withPort;
  }
  return urls.find((url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) ?? urls[0];
}

function resolveCwd(ctx: ToolContext, args: Record<string, unknown>): string {
  const value = typeof args.cwd === "string" ? args.cwd.trim() : "";
  return value === "" ? ctx.cwd : path.resolve(ctx.cwd, value);
}

/** Explicit command, else package.json `dev`, else `start`, else undefined. */
function resolveCommand(cwd: string, args: Record<string, unknown>): string | undefined {
  const explicit = typeof args.command === "string" ? args.command.trim() : "";
  if (explicit !== "") return explicit;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    const scripts =
      parsed !== null && typeof parsed === "object" && (parsed as { scripts?: unknown }).scripts !== null
        ? ((parsed as { scripts?: Record<string, unknown> }).scripts ?? {})
        : {};
    const hasBun = typeof Bun !== "undefined" && typeof Bun.which === "function" && Bun.which("bun") !== null;
    const runner = hasBun ? "bun" : "npm";
    if (typeof scripts.dev === "string") return `${runner} run dev`;
    if (typeof scripts.start === "string") return `${runner} run start`;
  } catch {
    /* no package.json or unreadable: only an explicit command can work */
  }
  return undefined;
}

function entriesFor(sessionId: string): PreviewEntry[] {
  let list = PREVIEWS.get(sessionId);
  if (!list) {
    list = [];
    PREVIEWS.set(sessionId, list);
  }
  return list;
}

async function startPreview(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const cwd = resolveCwd(ctx, args);
  const command = resolveCommand(cwd, args);
  if (command === undefined) {
    return {
      ok: false,
      output: "No command to start: pass `command`, or add a `dev` or `start` script to package.json.",
      error: "no preview command",
    };
  }
  const portNumber = typeof args.port === "number" && Number.isFinite(args.port) ? Math.floor(args.port) : undefined;

  // The same guard path a shell command would take.
  let decision: { decision: string; reason?: string };
  try {
    decision = await ctx.guard({ kind: "shell.exec", target: command });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `DENIED by policy: guard unavailable (${message})`, error: "guard unavailable" };
  }
  if (decision.decision === "deny") {
    const reason = decision.reason ?? "shell.exec";
    return { ok: false, output: `DENIED by policy: ${reason}`, error: `DENIED by policy: ${reason}` };
  }
  if (decision.decision === "ask") {
    let approved = false;
    try {
      approved = await ctx.approve({ title: `start preview: ${command}`, detail: command, kind: "shell.exec" });
    } catch {
      approved = false;
    }
    if (!approved) return { ok: false, output: "DECLINED by the user", error: "DECLINED by the user" };
  }

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-lc", command], {
      cwd,
      detached: true, // its own process group, so stop can kill the whole tree
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `could not start the preview: ${message}`, error: message };
  }

  const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : -1;
  if (pid < 0) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* nothing to kill */
    }
    return { ok: false, output: "could not start the preview: no pid", error: "spawn failed" };
  }

  const entry: PreviewEntry = {
    id: newId().slice(0, 8),
    pid,
    cmd: command,
    cwd,
    startedAt: Date.now(),
    child,
    output: "",
  };
  const entries = entriesFor(ctx.sessionId);
  entries.push(entry);

  // Keep draining the pipes for the life of the entry: a full pipe would
  // otherwise stall the server. This also feeds the ring buffer and URL scan.
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendOutput(entry, chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => appendOutput(entry, chunk));
  child.on("error", () => {
    /* reported through exitCode/status */
  });

  const deadline = Date.now() + URL_WAIT_MS;
  for (;;) {
    const url = scanUrl(entry.output, portNumber);
    if (url !== undefined) {
      entry.url = url;
      return { ok: true, output: `Preview running at ${url} (pid ${pid}, id ${entry.id})\ncommand: ${command}` };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await killEntry(entry);
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      return {
        ok: false,
        output: `Preview command exited (code ${child.exitCode ?? "signal"}) before announcing a URL\n--- output ---\n${tail(entry)}`,
        error: `preview exited (${child.exitCode ?? "signal"})`,
      };
    }
    if (Date.now() >= deadline) {
      return {
        ok: true,
        output:
          `Preview started but no URL detected within ${URL_WAIT_MS / 1000}s (pid ${pid}, id ${entry.id})\n` +
          `warning: the server may still be starting — check again with status\ncommand: ${command}\n--- output ---\n${tail(entry)}`,
      };
    }
    await sleep(250);
  }
}

async function stopPreviews(ctx: ToolContext): Promise<ToolResult> {
  const entries = PREVIEWS.get(ctx.sessionId) ?? [];
  if (entries.length === 0) return { ok: true, output: "No previews to stop." };
  const lines: string[] = [];
  for (const entry of [...entries]) {
    await killEntry(entry);
    lines.push(`Stopped preview ${entry.id} (pid ${entry.pid}) — ${entry.cmd}`);
  }
  PREVIEWS.delete(ctx.sessionId);
  return { ok: true, output: lines.join("\n") };
}

function statusPreviews(ctx: ToolContext): ToolResult {
  const entries = PREVIEWS.get(ctx.sessionId) ?? [];
  if (entries.length === 0) return { ok: true, output: "No previews." };
  const lines = entries.map((entry) => {
    const up = Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000));
    const state = alive(entry.pid) ? "running" : "exited";
    return `- ${entry.id} pid ${entry.pid} ${state} ${entry.url ?? "(no url yet)"} up ${up}s — ${entry.cmd}`;
  });
  return { ok: true, output: lines.join("\n") };
}

export const previewTool: Tool = {
  name: "preview",
  description:
    "Start, stop, or check a local preview server for the project (dev server, static server, or an explicit command).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "stop", "status"], description: "Preview operation." },
      command: { type: "string", description: "Explicit command to run (defaults to the package.json dev or start script)." },
      cwd: { type: "string", description: "Working directory for the server (defaults to the workspace)." },
      port: { type: "number", description: "Expected port, used to spot the URL in the server output." },
    },
    required: ["action"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const action = args.action;
      if (action !== "start" && action !== "stop" && action !== "status") {
        return { ok: false, output: "", error: `unknown action: ${String(action)} (expected start, stop or status)` };
      }
      if (action === "start") return await startPreview(args, ctx);
      if (action === "stop") return await stopPreviews(ctx);
      return statusPreviews(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `preview failed: ${message}`, error: message };
    }
  },
};

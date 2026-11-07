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

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { newId } from "../contracts";
import { kernelStateDir, spawnOwned, type OwnedProc } from "../core/owned-spawn";
import { scrubEnv } from "./helpers";

const OUTPUT_CAP = 4096;
const URL_WAIT_MS = 12_000;

interface PreviewEntry {
  id: string;
  pid: number;
  cmd: string;
  cwd: string;
  url?: string;
  startedAt: number;
  proc: OwnedProc;
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

/** Drain one child stream into the entry's ring buffer until it closes. */
async function pumpToOutput(stream: ReadableStream<Uint8Array> | undefined, entry: PreviewEntry): Promise<void> {
  if (stream === undefined) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) appendOutput(entry, decoder.decode(value, { stream: true }));
    }
  } catch {
    /* stream closed by a kill */
  }
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
        entry.proc.kill(sig);
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
  const action: GuardAction = { kind: "shell.exec", target: command };
  let decision: { decision: string; reason?: string };
  try {
    decision = await ctx.guard(action);
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
      approved = await ctx.approve({ title: `start preview: ${command}`, detail: command, kind: "shell.exec" }, action);
    } catch {
      approved = false;
    }
    if (!approved) return { ok: false, output: "DECLINED by the user", error: "DECLINED by the user" };
  }

  let proc: OwnedProc;
  try {
    // NF-071: the single spawn path. A preview is long-lived, so the owner-death
    // supervisor starts with it — a SIGKILL of hzcode can no longer leave a dev
    // server (or its children) behind; `detached` is what the supervisor's
    // killpg needs, and it is also what stop relies on to kill the whole tree.
    ({ proc } = await spawnOwned(["bash", "-lc", command], {
      stateDir: kernelStateDir(ctx.workspace),
      label: `preview: ${command}`,
      cwd,
      // Every process-spawning tool scrubs the environment (helpers rule): a dev
      // server must never inherit provider keys or other secrets from hzcode.
      env: scrubEnv(),
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      detached: true, // its own process group, so stop can kill the whole tree
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `could not start the preview: ${message}`, error: message };
  }

  const pid = proc.pid;

  const entry: PreviewEntry = {
    id: newId().slice(0, 8),
    pid,
    cmd: command,
    cwd,
    startedAt: Date.now(),
    proc,
    output: "",
  };
  const entries = entriesFor(ctx.sessionId);
  entries.push(entry);

  // Keep draining the pipes for the life of the entry: a full pipe would
  // otherwise stall the server. This also feeds the ring buffer and URL scan.
  void pumpToOutput(proc.stdout, entry);
  void pumpToOutput(proc.stderr, entry);

  const deadline = Date.now() + URL_WAIT_MS;
  for (;;) {
    const url = scanUrl(entry.output, portNumber);
    if (url !== undefined) {
      entry.url = url;
      return { ok: true, output: `Preview running at ${url} (pid ${pid}, id ${entry.id})\ncommand: ${command}` };
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await killEntry(entry);
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      return {
        ok: false,
        output: `Preview command exited (code ${proc.exitCode ?? "signal"}) before announcing a URL\n--- output ---\n${tail(entry)}`,
        error: `preview exited (${proc.exitCode ?? "signal"})`,
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

  // NF-072: a lifecycle tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

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

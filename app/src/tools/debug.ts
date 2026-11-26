/**
 * `debug` — DAP stack/locals against a user-supplied adapter (docs/33 §5.1 partial).
 *
 * hzcode spawns the adapter (`spawn` admission) and talks DAP on its stdio. `stack`/`variables`
 * are read-only. `launch` / `attach` / step ops admit via `shell.exec`, then run OMP-ordered
 * DAP sequencing (`session.ts`). A live adapter is kept in `dap/registry.ts` per chat session
 * so step/stack reuse it; `close` disposes. A real adapter still owns the debuggee process.
 */

import type { ApprovalRequest, GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { DapClient, dapSpawnAction, type DapStackFrame, type DapVariable } from "../core/dap/client";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import { resolveAdapter, selectAdapterForProgram } from "../core/dap/config";
import {
  disposeLiveDapSession,
  getLiveDapSession,
  setLiveDapSession,
  sweepIdleDapSessions,
  type LiveDapSession,
} from "../core/dap/registry";
import { attachSession, launchSession, stepSession, type DapStepCommand } from "../core/dap/session";
import { connectDapTcp, waitForDapListenEndpoint } from "../core/dap/transport";
import { kernelStateDir, spawnOwned, type OwnedProc } from "../core/owned-spawn";
import { scrubEnv } from "./helpers";

const STEP_OPS = new Set<DapStepCommand>(["continue", "next", "stepIn", "stepOut"]);
const ALL_OPS = new Set(["stack", "variables", "launch", "attach", "close", "continue", "next", "stepIn", "stepOut"]);
const STDERR_RING_MAX = 16 * 1024;

/** Drain adapter stderr continuously into a bounded ring buffer to prevent >64 KiB pipe deadlock. */
function drainStderrRing(stream: ReadableStream<Uint8Array> | undefined): { tail(): string } {
  let ring = "";
  if (stream !== undefined) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            ring = (ring + decoder.decode(value, { stream: true })).slice(-STDERR_RING_MAX);
          }
        }
      } catch {
        /* stream closed */
      }
    })();
  }
  return { tail: () => ring.trim() };
}

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

function stdinWrite(proc: OwnedProc, frame: Uint8Array): void {
  const sink = proc.stdin as unknown as { write(data: Uint8Array): unknown };
  sink.write(frame);
}

async function pumpDapStdout(proc: OwnedProc, client: DapClient, signal: AbortSignal): Promise<void> {
  const reader = proc.stdout.getReader();
  try {
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) client.push(value);
    }
  } catch {
    /* stream closed */
  }
}

function formatStack(frames: DapStackFrame[]): string {
  if (frames.length === 0) return "no stack frames";
  return frames.map((f, i) => `${i}: ${f.name} (line ${f.line}, frameId=${f.id})`).join("\n");
}

function formatVariables(vars: DapVariable[]): string {
  if (vars.length === 0) return "no variables";
  return vars.map((v) => `${v.name} = ${v.value}`).join("\n");
}

async function admitAdapterSpawn(ctx: ToolContext, command: string, argvTail: string[]): Promise<string | undefined> {
  const action = dapSpawnAction(command, argvTail);
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return decision.reason ?? "spawn denied by policy";
  }
  if (decision.decision === "ask") {
    const req: ApprovalRequest = { title: "Start debug adapter", detail: action.target, kind: action.kind };
    const approved = await ctx.approve(req, action);
    if (!approved) return "DECLINED by the user";
  }
  return undefined;
}

async function admitShellExec(ctx: ToolContext, target: string): Promise<string | undefined> {
  const action: GuardAction = { kind: "shell.exec", target };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return decision.reason ?? "shell.exec denied by policy";
  }
  if (decision.decision === "ask") {
    const req: ApprovalRequest = { title: "Debug execution", detail: target, kind: action.kind };
    const approved = await ctx.approve(req, action);
    if (!approved) return "DECLINED by the user";
  }
  return undefined;
}

async function startAdapter(
  ctx: ToolContext,
  command: string,
  argvTail: string[],
  connectMode: "stdio" | "socket" | "tcp" = "stdio",
): Promise<{ live: LiveDapSession } | { error: string }> {
  const denied = await admitAdapterSpawn(ctx, command, argvTail);
  if (denied !== undefined) return { error: denied };
  await disposeLiveDapSession(ctx.workspace, ctx.sessionId);
  const stateDir = kernelStateDir(ctx.workspace);
  let proc: OwnedProc;
  try {
    ({ proc } = await spawnOwned([command, ...argvTail], {
      stateDir,
      cwd: ctx.cwd,
      env: scrubEnv(),
      label: "debug:adapter",
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      longLived: true,
      sandboxWrap: "auto",
      sandboxMode: ctx.sandboxMode ?? "workspace-write",
      kernel: ctx.kernel,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `could not start adapter: ${message}` };
  }
  drainStderrRing(proc.stderr);

  if (connectMode === "tcp" || connectMode === "socket") {
    try {
      const reader = proc.stdout.getReader();
      const endpoint = await waitForDapListenEndpoint(async () => {
        const { done, value } = await reader.read();
        if (done) return null;
        return value ?? null;
      });
      // Keep draining leftover stdout so the child cannot block on a full pipe.
      void (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* closed */
        }
      })();
      const pipe = await connectDapTcp(endpoint);
      const client = new DapClient({
        write: (frame) => pipe.write(frame),
        requestTimeoutMs: 10_000,
      });
      const pump = pipe.pump((chunk) => client.push(chunk));
      const live: LiveDapSession = {
        client,
        proc,
        pump,
        workspace: ctx.workspace,
        sessionId: ctx.sessionId,
        lastUsedAt: Date.now(),
        transportClose: () => pipe.close(),
      };
      setLiveDapSession(live);
      return { live };
    } catch (err) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err);
      return { error: `could not connect DAP TCP: ${message}` };
    }
  }

  const client = new DapClient({
    write: (frame) => stdinWrite(proc, frame),
    requestTimeoutMs: 10_000,
  });
  // Pump for the life of the adapter; do not abort on per-call signal (session outlives one tool call).
  const pump = pumpDapStdout(proc, client, new AbortController().signal);
  const live: LiveDapSession = {
    client,
    proc,
    pump,
    workspace: ctx.workspace,
    sessionId: ctx.sessionId,
    lastUsedAt: Date.now(),
  };
  setLiveDapSession(live);
  return { live };
}

async function ephemeralAdapter(
  ctx: ToolContext,
  command: string,
  argvTail: string[],
  run: (client: DapClient) => Promise<ToolResult>,
): Promise<ToolResult> {
  const denied = await admitAdapterSpawn(ctx, command, argvTail);
  if (denied !== undefined) return fail(denied);
  const stateDir = kernelStateDir(ctx.workspace);
  let proc: OwnedProc;
  try {
    ({ proc } = await spawnOwned([command, ...argvTail], {
      stateDir,
      cwd: ctx.cwd,
      env: scrubEnv(),
      label: "debug:adapter",
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      longLived: false,
      sandboxWrap: "auto",
      sandboxMode: ctx.sandboxMode ?? "workspace-write",
      kernel: ctx.kernel,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`could not start adapter: ${message}`);
  }
  drainStderrRing(proc.stderr);
  const client = new DapClient({
    write: (frame) => stdinWrite(proc, frame),
    requestTimeoutMs: 10_000,
  });
  const pump = pumpDapStdout(proc, client, ctx.signal);
  try {
    return await run(client);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`dap query failed: ${message}`);
  } finally {
    try {
      (proc.stdin as unknown as { end?: () => void })?.end?.();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await pump.catch(() => undefined);
  }
}

export const debugTool: Tool = {
  name: "debug",
  description:
    "Debugger over DAP. stack/variables are read-only; launch/attach keep a live adapter for the chat session; " +
    "continue/next/stepIn/stepOut reuse it; close disposes. Pass command, or adapter name from defaults " +
    "(debugpy/gdb/…), or let launch auto-pick from program extension. OMP sequencing in session.ts.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["stack", "variables", "launch", "attach", "close", "continue", "next", "stepIn", "stepOut"],
        description: "stack, variables, launch, attach, close, continue, next (step over), stepIn, or stepOut.",
      },
      command: { type: "string", description: "Executable that speaks DAP on stdio (optional when adapter is set)." },
      adapter: {
        type: "string",
        description: "Named adapter from dap/defaults.json (e.g. debugpy, gdb, lldb-dap); resolved via PATH.",
      },
      program: {
        type: "string",
        description: "Debuggee command line (required for launch and step ops; admitted as shell.exec).",
      },
      pid: { type: "number", description: "Process id to attach (attach op; admitted as shell.exec)." },
      port: { type: "number", description: "Debug port to attach (attach op; with optional host)." },
      host: { type: "string", description: "Host for port attach (default 127.0.0.1)." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Argv tail for the adapter (optional; merged after catalogue defaults).",
      },
    },
    required: ["op"],
  },
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: { keywords: ["debug", "debugger", "dap", "stack", "variables", "breakpoint", "step", "attach"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = typeof args.op === "string" ? args.op : "";
    if (!ALL_OPS.has(op)) {
      return fail(`unsupported op: ${op} (supports ${[...ALL_OPS].join(", ")})`);
    }

    await sweepIdleDapSessions();

    if (op === "close") {
      const closed = await disposeLiveDapSession(ctx.workspace, ctx.sessionId);
      return { ok: true, output: closed ? "DAP session closed" : "no live DAP session" };
    }

    const liveExisting = getLiveDapSession(ctx.workspace, ctx.sessionId);

    // Step on a live session: reuse adapter without requiring command/adapter again.
    if (STEP_OPS.has(op as DapStepCommand) && liveExisting) {
      try {
        const program =
          (typeof args.program === "string" ? args.program.trim() : "") || liveExisting.program || "(live)";
        const shellDenied = await admitShellExec(ctx, program);
        if (shellDenied !== undefined) return fail(shellDenied);
        const stepped = await stepSession(liveExisting.client, op as DapStepCommand);
        const frameLine = stepped.frames.length > 0 ? `\n${formatStack(stepped.frames)}` : "";
        return {
          ok: true,
          output:
            `DAP ${op} ok; status=${stepped.status}` +
            (stepped.stopReason ? ` stopReason=${stepped.stopReason}` : "") +
            `\nprogram (admitted as shell.exec): ${program}; live session reused${frameLine}`,
        };
      } catch (err) {
        tunnelPermissionError(err);
        const message = err instanceof Error ? err.message : String(err);
        return fail(`dap query failed: ${message}`);
      }
    }

    // stack/variables prefer a live session when present (no command/adapter required).
    if ((op === "stack" || op === "variables") && liveExisting) {
      try {
        if (op === "stack") {
          return { ok: true, output: formatStack(await liveExisting.client.stack()) };
        }
        const frames = await liveExisting.client.stack();
        const top = frames[0];
        if (top === undefined) return { ok: true, output: "no stack frames (cannot read variables)" };
        return { ok: true, output: formatVariables(await liveExisting.client.locals(top.id)) };
      } catch (err) {
        tunnelPermissionError(err);
        const message = err instanceof Error ? err.message : String(err);
        return fail(`dap query failed: ${message}`);
      }
    }

    const needsProgram = op === "launch" || STEP_OPS.has(op as DapStepCommand);
    const isAttach = op === "attach";
    if (needsProgram) {
      const program = typeof args.program === "string" ? args.program.trim() : "";
      if (program === "") return fail(`program is required for ${op}`);
    }

    const explicitCommand = typeof args.command === "string" ? args.command.trim() : "";
    const adapterName = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const extraArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
    let command = explicitCommand;
    let argvTail = extraArgs;
    let connectMode: "stdio" | "socket" | "tcp" = "stdio";
    if (adapterName !== "") {
      const resolved = resolveAdapter(adapterName, ctx.cwd);
      if (!resolved) {
        return fail(`adapter ${adapterName} not found on PATH`);
      }
      command = resolved.resolvedCommand;
      argvTail = [...resolved.args, ...extraArgs];
      connectMode = resolved.connectMode ?? "stdio";
    } else if (command === "" && needsProgram) {
      const program = typeof args.program === "string" ? args.program.trim() : "";
      const first = program.split(/\s+/).filter((p) => p !== "")[0] ?? program;
      const picked = selectAdapterForProgram(first, ctx.cwd);
      if (!picked) {
        return fail(
          "command or adapter is required (no adapter matched program extension; install debugpy/gdb/dlv/… or pass command)",
        );
      }
      command = picked.resolvedCommand;
      argvTail = [...picked.args, ...extraArgs];
      connectMode = picked.connectMode ?? "stdio";
    } else if (command === "") {
      return fail("command or adapter is required");
    }
    let attachPid: number | undefined;
    let attachPort: number | undefined;
    let attachHost: string | undefined;
    if (isAttach) {
      attachPid = typeof args.pid === "number" && Number.isInteger(args.pid) && args.pid > 0 ? args.pid : undefined;
      attachPort = typeof args.port === "number" && Number.isInteger(args.port) && args.port > 0 ? args.port : undefined;
      attachHost = typeof args.host === "string" ? args.host.trim() : undefined;
      if (attachPid === undefined && attachPort === undefined) {
        return fail("attach requires pid or port");
      }
    }

    if (isAttach || op === "launch" || STEP_OPS.has(op as DapStepCommand)) {
      const program = typeof args.program === "string" ? args.program.trim() : "";
      const shellTarget = isAttach
        ? attachPid !== undefined
          ? `attach:pid=${attachPid}`
          : `attach:${attachHost ?? "127.0.0.1"}:${attachPort}`
        : program;
      const shellDenied = await admitShellExec(ctx, shellTarget);
      if (shellDenied !== undefined) return fail(shellDenied);

      const started = await startAdapter(ctx, command, argvTail, connectMode);
      if ("error" in started) return fail(started.error);
      const { live } = started;
      try {
        if (isAttach) {
          const attached = await attachSession(live.client, {
            pid: attachPid,
            port: attachPort,
            host: attachHost,
            cwd: ctx.cwd,
          });
          live.attachTarget = attached.target;
          const frameLine = attached.frames.length > 0 ? `\n${formatStack(attached.frames)}` : "";
          return {
            ok: true,
            output:
              `DAP attach ok; status=${attached.status}` +
              (attached.stopReason ? ` stopReason=${attached.stopReason}` : "") +
              `\ntarget (admitted as shell.exec): ${attached.target}; session kept live${frameLine}`,
          };
        }
        const argv = program.split(/\s+/).filter((p) => p !== "");
        const bin = argv[0] ?? program;
        const launched = await launchSession(live.client, {
          program: bin,
          args: argv.slice(1),
          cwd: ctx.cwd,
        });
        live.program = program;
        if (op === "launch") {
          const frameLine = launched.frames.length > 0 ? `\n${formatStack(launched.frames)}` : "";
          return {
            ok: true,
            output:
              `DAP launch ok; status=${launched.status}` +
              (launched.stopReason ? ` stopReason=${launched.stopReason}` : "") +
              `\nprogram (admitted as shell.exec): ${program}; session kept live${frameLine}`,
          };
        }
        const stepped = await stepSession(live.client, op as DapStepCommand);
        const frameLine = stepped.frames.length > 0 ? `\n${formatStack(stepped.frames)}` : "";
        return {
          ok: true,
          output:
            `DAP ${op} ok; status=${stepped.status}` +
            (stepped.stopReason ? ` stopReason=${stepped.stopReason}` : "") +
            `\nprogram (admitted as shell.exec): ${program}; session kept live${frameLine}`,
        };
      } catch (err) {
        tunnelPermissionError(err);
        await disposeLiveDapSession(ctx.workspace, ctx.sessionId);
        const message = err instanceof Error ? err.message : String(err);
        return fail(`dap query failed: ${message}`);
      }
    }

    // Ephemeral stack/variables when no live session.
    return ephemeralAdapter(ctx, command, argvTail, async (client) => {
      await client.ready();
      if (op === "stack") {
        return { ok: true, output: formatStack(await client.stack()) };
      }
      const frames = await client.stack();
      const top = frames[0];
      if (top === undefined) return { ok: true, output: "no stack frames (cannot read variables)" };
      return { ok: true, output: formatVariables(await client.locals(top.id)) };
    });
  },
};

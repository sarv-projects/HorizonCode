/**
 * dap/session.ts — launch/attach/step sequencing adapted from oh-my-pi session.ts (pin 21f1188).
 *
 * OMP rule: many adapters do not answer `launch`/`attach` until after `configurationDone`.
 * Subscribe to `stopped` before firing start; fire start without awaiting; send
 * configurationDone; then await start and optionally the initial stop.
 *
 * This is the real protocol state machine — not a stub. It still needs a real
 * adapter binary for a live debuggee; tests use the protocol fixture.
 */

import { DapClient, type DapCapabilities, type DapStackFrame } from "./client";

export type DapSessionStatus = "configuring" | "launching" | "running" | "stopped" | "terminated";

export interface DapStartResult {
  status: DapSessionStatus;
  stopped: boolean;
  stopReason?: string;
  frames: DapStackFrame[];
  capabilities: DapCapabilities;
}

export interface DapLaunchResult extends DapStartResult {
  program: string;
}

export interface DapAttachResult extends DapStartResult {
  target: string;
}

export interface DapLaunchOptions {
  program: string;
  args?: string[];
  cwd?: string;
  /** How long to wait for an initial `stopped` (stopOnEntry). Timeout → still success if launch ok. */
  stopTimeoutMs?: number;
}

export interface DapAttachOptions {
  pid?: number;
  port?: number;
  host?: string;
  cwd?: string;
  stopTimeoutMs?: number;
}

type StartFailure = { rejected: boolean; error?: unknown };

async function startWithConfigurationDone(
  client: DapClient,
  command: "launch" | "attach",
  args: Record<string, unknown>,
  stopTimeoutMs: number,
): Promise<DapStartResult> {
  const capabilities = await client.initialize();
  const needsConfigDone = capabilities.supportsConfigurationDoneRequest !== false;

  // Subscribe BEFORE start so stopOnEntry / attach-stop is not missed (OMP).
  const stopPromise = client.waitForEvent<{ reason?: string }>("stopped", undefined, stopTimeoutMs);

  const startFailure: StartFailure = { rejected: false };
  const startPromise = client.sendRequest(command, args).catch((error: unknown) => {
    startFailure.rejected = true;
    startFailure.error = error;
    throw error;
  });
  // Avoid unhandled rejection while configurationDone runs (OMP pattern).
  startPromise.catch(() => undefined);

  if (needsConfigDone) {
    try {
      await client.configurationDone();
    } catch (configError) {
      if (startFailure.rejected) {
        throw startFailure.error instanceof Error
          ? startFailure.error
          : new Error(`DAP ${command} failed: ${String(startFailure.error)}`);
      }
      throw configError;
    }
  }

  await startPromise;

  let stopped = false;
  let stopReason: string | undefined;
  let frames: DapStackFrame[] = [];
  try {
    const body = await stopPromise;
    stopped = true;
    stopReason = typeof body.reason === "string" ? body.reason : undefined;
    frames = await client.stack();
  } catch {
    // Timeout is acceptable — the program may simply be running (OMP).
  }

  return {
    status: stopped ? "stopped" : "running",
    stopped,
    stopReason,
    frames,
    capabilities,
  };
}

/**
 * Run DAP initialize → launch (in flight) → configurationDone → await launch → wait stopped.
 * Matches oh-my-pi `DapSessionManager.launch` ordering.
 */
export async function launchSession(client: DapClient, options: DapLaunchOptions): Promise<DapLaunchResult> {
  const launchArgs: Record<string, unknown> = {
    program: options.program,
    stopOnEntry: true,
  };
  if (options.args !== undefined) launchArgs.args = options.args;
  if (options.cwd !== undefined) launchArgs.cwd = options.cwd;

  const started = await startWithConfigurationDone(
    client,
    "launch",
    launchArgs,
    options.stopTimeoutMs ?? 5_000,
  );
  return { ...started, program: options.program };
}

/** Human-readable attach target for admissions / tool output. */
export function attachTargetLabel(options: Pick<DapAttachOptions, "pid" | "port" | "host">): string {
  if (options.pid !== undefined) return `attach:pid=${options.pid}`;
  if (options.port !== undefined) {
    const host = options.host?.trim() || "127.0.0.1";
    return `attach:${host}:${options.port}`;
  }
  return "attach";
}

/**
 * Run DAP initialize → attach (in flight) → configurationDone → await attach → wait stopped.
 * Matches oh-my-pi `DapSessionManager.attach` ordering (pid/port/host args).
 */
export async function attachSession(client: DapClient, options: DapAttachOptions): Promise<DapAttachResult> {
  if (options.pid === undefined && options.port === undefined) {
    throw new Error("DAP attach requires pid or port");
  }
  const attachArgs: Record<string, unknown> = {};
  if (options.cwd !== undefined) attachArgs.cwd = options.cwd;
  if (options.pid !== undefined) {
    attachArgs.pid = options.pid;
    attachArgs.processId = options.pid;
  }
  if (options.port !== undefined) attachArgs.port = options.port;
  if (options.host !== undefined && options.host.trim() !== "") attachArgs.host = options.host.trim();

  const started = await startWithConfigurationDone(
    client,
    "attach",
    attachArgs,
    options.stopTimeoutMs ?? 5_000,
  );
  return { ...started, target: attachTargetLabel(options) };
}

export type DapStepCommand = "continue" | "next" | "stepIn" | "stepOut";

export interface DapStepResult {
  command: DapStepCommand;
  status: DapSessionStatus;
  stopped: boolean;
  stopReason?: string;
  frames: DapStackFrame[];
}

/**
 * After a stop: subscribe to the next `stopped`, send continue/next/stepIn/stepOut,
 * then await the stop (oh-my-pi `continue` / `#step`).
 */
export async function stepSession(
  client: DapClient,
  command: DapStepCommand,
  options: { threadId?: number; stopTimeoutMs?: number } = {},
): Promise<DapStepResult> {
  const threads = (await client.sendRequest("threads")) as { threads?: Array<{ id: number }> };
  const threadId = options.threadId ?? threads.threads?.[0]?.id ?? 1;
  const stopTimeout = options.stopTimeoutMs ?? 5_000;

  // Subscribe BEFORE the command so a same-chunk stopped event is not missed (OMP).
  const stopPromise = client.waitForEvent<{ reason?: string }>("stopped", undefined, stopTimeout);
  await client.sendRequest(command, { threadId });

  let stopped = false;
  let stopReason: string | undefined;
  let frames: DapStackFrame[] = [];
  try {
    const body = await stopPromise;
    stopped = true;
    stopReason = typeof body.reason === "string" ? body.reason : undefined;
    frames = await client.stack();
  } catch {
    // continue may run until exit without another stop
  }

  return {
    command,
    status: stopped ? "stopped" : "running",
    stopped,
    stopReason,
    frames,
  };
}

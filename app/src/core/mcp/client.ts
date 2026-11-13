/**
 * client.ts — the MCP stdio client (docs/09 §4.7 / R-tools-18/19/33, reduced
 * form).
 *
 * One server, one child process, newline-delimited JSON-RPC 2.0 on its
 * stdin/stdout — the transport half of the MCP surface. The spawn goes through
 * `spawnOwned` (NF-071: the one spawn path), so the server is in the ledger and
 * dies with its owner. The environment is `scrubEnv()` plus the server's own
 * config `env` values: a configured server may carry exactly the values its
 * config names, but it never inherits provider keys or other credentials by
 * accident.
 *
 * Handshake: `initialize` (a request) -> `notifications/initialized` (a
 * notification) -> paginated `tools/list` (cursor passthrough until
 * `nextCursor` is absent). The merged list is the server's claimed tool set;
 * the registry decides what the model may see
 * (R-tools-18/R-tools-19), this module only reports `annotations.readOnlyHint`
 * verbatim.
 *
 * Timings (v1 constants, injectable for tests): connect 10 s for the WHOLE
 * handshake, one call 30 s. The call timeout covers the whole operation — queue
 * wait included — so a call queued behind the per-server cap or a reconnect
 * cannot sit forever.
 *
 * Per-server concurrency is capped at 2 in-flight calls (docs/09 §10: the
 * model-facing cap for MCP; excess calls queue).
 *
 * Transport death is bounded, not silent: the pending calls fail with a typed
 * `McpTransportError`, the server's tools are reported gone immediately, and up
 * to 3 reconnects are attempted with backoff 250 ms * 2^n. When every attempt
 * fails the client is marked DOWN — `McpServerDownError` via `onDown` plus a
 * notice; a stopped client never reconnects.
 *
 * Reduced form, stated honestly: only stdio transport; no OAuth (a server that
 * needs auth must be started with whatever its own launch supplies); a
 * reconnect re-runs the handshake and re-lists tools but does not replay a call
 * that died (the call already left the process — its outcome is unknown and is
 * reported as a typed failure, never a retry); `notifications/tools/list_changed`
 * triggers one best-effort re-list; server -> client requests are answered
 * `-32601` rather than served. A failed handshake reaps its child, so a connect
 * that timed out leaves no process behind.
 */

import { scrubEnv } from "../../tools/helpers";
import { spawnOwned, type OwnedProc } from "../owned-spawn";
import { listAllMcpResources, listAllMcpTools, mcpListRequestParams } from "./list-pagination";

/** The MCP protocol revision this client announces (docs/09 §4.7, v1). */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
/** The client name/version sent in `initialize`. */
export const MCP_CLIENT_NAME = "hzcode";
export const MCP_CLIENT_VERSION = "0.1.0";
/** Connect (initialize + tools/list) budget. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
/** One `tools/call` round trip budget (queue wait included). */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Concurrent in-flight calls allowed per server; excess queues. */
export const MCP_MAX_IN_FLIGHT = 2;
/** Reconnect attempts after a transport death, then DOWN. */
export const MCP_MAX_RECONNECTS = 3;
/** First reconnect backoff; doubled per attempt (250 ms * 2^n). */
export const MCP_RECONNECT_BASE_MS = 250;
/** SIGTERM -> SIGKILL grace when stopping or replacing a child. */
const KILL_GRACE_MS = 300;
/** Byte cap on the stderr tail kept for diagnostics. */
const STDERR_TAIL_CAP = 4_000;

/* --------------------------------- errors --------------------------------- */

export type McpErrorKind = "transport" | "timeout" | "protocol" | "rpc" | "down" | "aborted" | "config";

/** Every failure this module reports is typed and names its server. */
export class McpError extends Error {
  readonly kind: McpErrorKind;
  readonly serverId: string;

  constructor(kind: McpErrorKind, serverId: string, message: string) {
    super(`mcp[${serverId}]: ${message}`);
    this.name = "McpError";
    this.kind = kind;
    this.serverId = serverId;
  }
}

/** The child died, could not start, or could not be written to. */
export class McpTransportError extends McpError {
  constructor(serverId: string, message: string) {
    super("transport", serverId, message);
    this.name = "McpTransportError";
  }
}

/** A request got no response inside its budget. */
export class McpTimeoutError extends McpError {
  constructor(serverId: string, message: string) {
    super("timeout", serverId, message);
    this.name = "McpTimeoutError";
  }
}

/** The server's bytes were not the shape the protocol requires. */
export class McpProtocolError extends McpError {
  constructor(serverId: string, message: string) {
    super("protocol", serverId, message);
    this.name = "McpProtocolError";
  }
}

/** The server answered with a JSON-RPC error object. */
export class McpRpcError extends McpError {
  readonly code: number | undefined;

  constructor(serverId: string, code: number | undefined, message: string) {
    super("rpc", serverId, message);
    this.name = "McpRpcError";
    this.code = code;
  }
}

/** Every reconnect attempt failed; the server is DOWN until a human retries. */
export class McpServerDownError extends McpError {
  constructor(serverId: string, message: string) {
    super("down", serverId, message);
    this.name = "McpServerDownError";
  }
}

/** The caller's signal aborted while waiting. */
export class McpAbortedError extends McpError {
  constructor(serverId: string, message = "aborted") {
    super("aborted", serverId, message);
    this.name = "McpAbortedError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON that cannot round-trip must not sink a result: fall back to String(). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* --------------------------------- types --------------------------------- */

/** A server resource as `resources/list` reported it (claims only). */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A server tool as `tools/list` reported it (claims only — see R-tools-19). */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** The server's input schema, handed to the registry VERBATIM. */
  inputSchema?: Record<string, unknown>;
  /** `annotations.readOnlyHint`; absent/false means mutating (R-tools-19). */
  readOnlyHint?: boolean;
}

/** One `tools/call` outcome, reduced to what the registry renders. */
export interface McpCallResult {
  /** The server flagged the call itself as failed (`isError`). */
  isError: boolean;
  /** The text parts in order; JSON of the raw result when it carries no text. */
  text: string;
  /** The raw JSON-RPC result, for callers that need more than text. */
  raw: unknown;
}

/** The minimal slice of this client the registry calls; kept small on purpose. */
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
}

export interface McpClientOptions {
  serverId: string;
  /** The program to start (config `command`). */
  command: string;
  args?: string[];
  /** Extra environment entries merged ON TOP of the scrubbed environment. */
  env?: Record<string, string>;
  cwd?: string;
  /** Where the spawn ledger lives: `<stateDir>/spawns.jsonl`. */
  stateDir: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxInFlight?: number;
  maxReconnects?: number;
  reconnectBaseMs?: number;
  /** Called with the server's tool list after every successful handshake. */
  onTools?: (serverId: string, tools: McpToolInfo[]) => void;
  /** Called once when reconnects are exhausted (the server is DOWN). */
  onDown?: (serverId: string, error: McpServerDownError) => void;
  onNotice?: (message: string) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

type ClientState = "idle" | "connecting" | "connected" | "reconnecting" | "down" | "stopped";

/** Simple counting semaphore; a released slot transfers to the oldest waiter. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // the slot is handed over; `active` is unchanged
    else this.active = Math.max(0, this.active - 1);
  }
}

/* --------------------------------- client --------------------------------- */

/**
 * One MCP server over stdio. Call `connect()` first; then `callTool()`; call
 * `stop()` to reap the child. The client reconnects (bounded) on transport
 * death but never retries a call that already left the process.
 */
export class McpClient implements McpToolCaller {
  readonly serverId: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly cwd: string | undefined;
  private readonly stateDir: string;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly maxReconnects: number;
  private readonly reconnectBaseMs: number;
  private readonly semaphore: Semaphore;
  private readonly onTools?: (serverId: string, tools: McpToolInfo[]) => void;
  private readonly onDown?: (serverId: string, error: McpServerDownError) => void;
  private readonly onNotice?: (message: string) => void;

  private proc: OwnedProc | undefined;
  private buffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private readonly pendingCalls = new Map<number, PendingCall>();
  /** Monotonic id of the current child: events from an older one are discarded. */
  private epoch = 0;
  private stateValue: ClientState = "idle";
  private toolsValue: McpToolInfo[] = [];
  private stopping = false;
  private reconnectTask: Promise<void> | undefined;
  private reconnectAttemptsValue = 0;
  private downErrorValue: McpServerDownError | undefined;
  private readonly downWaiters: Array<(err: McpError) => void> = [];

  constructor(opts: McpClientOptions) {
    if (typeof opts?.serverId !== "string" || opts.serverId.trim() === "") {
      throw new McpError("config", String(opts?.serverId ?? ""), "serverId is required");
    }
    if (typeof opts?.command !== "string" || opts.command.trim() === "") {
      throw new McpError("config", opts.serverId, "command is required");
    }
    this.serverId = opts.serverId;
    this.command = opts.command;
    this.args = Array.isArray(opts.args) ? opts.args.filter((arg): arg is string => typeof arg === "string") : [];
    this.env = opts.env ?? {};
    this.cwd = opts.cwd;
    this.stateDir = opts.stateDir;
    this.connectTimeoutMs = opts.connectTimeoutMs && opts.connectTimeoutMs > 0 ? opts.connectTimeoutMs : MCP_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : MCP_CALL_TIMEOUT_MS;
    this.maxReconnects = opts.maxReconnects && opts.maxReconnects > 0 ? Math.floor(opts.maxReconnects) : MCP_MAX_RECONNECTS;
    this.reconnectBaseMs = opts.reconnectBaseMs && opts.reconnectBaseMs > 0 ? opts.reconnectBaseMs : MCP_RECONNECT_BASE_MS;
    this.semaphore = new Semaphore(opts.maxInFlight && opts.maxInFlight > 0 ? Math.floor(opts.maxInFlight) : MCP_MAX_IN_FLIGHT);
    this.onTools = opts.onTools;
    this.onDown = opts.onDown;
    this.onNotice = opts.onNotice;
  }

  get state(): ClientState {
    return this.stateValue;
  }

  /** The server's claims as of the last successful `tools/list`; [] while down. */
  get tools(): McpToolInfo[] {
    return this.toolsValue;
  }

  /** How many reconnect attempts the last death consumed (0: never died). */
  get reconnectAttempts(): number {
    return this.reconnectAttemptsValue;
  }

  /** The live child's pid, or undefined when nothing is running. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Resolves once the server is DOWN; only useful after a transport death. */
  whenDown(): Promise<McpError> {
    if (this.downErrorValue !== undefined) return Promise.resolve(this.downErrorValue);
    return new Promise<McpError>((resolve) => this.downWaiters.push(resolve));
  }

  /** Recent stderr from the live/dead child, for diagnostics only. */
  stderrTail(): string {
    return this.stderrBuffer;
  }

  /**
   * Spawn, handshake and list tools. Resolves with the server's claimed tools.
   * A failed initial connect does not schedule reconnects (v1 reduced form: the
   * MANAGER skips the server and notices; retrying is the human's call).
   */
  async connect(): Promise<McpToolInfo[]> {
    if (this.stopping) throw new McpTransportError(this.serverId, "client was stopped");
    if (this.stateValue === "connected") return this.toolsValue;
    this.stateValue = "connecting";
    try {
      const tools = await this.spawnAndHandshake();
      this.stateValue = "connected";
      this.emitTools(tools);
      return tools;
    } catch (err) {
      this.stateValue = this.stopping ? "stopped" : "idle";
      throw err;
    }
  }

  /**
   * One `tools/call` request. `timeoutMs` (if given) replaces the call budget
   * for this call only; the budget covers queue and reconnect wait too. The
   * call is never retried: once its bytes are on the wire, a lost response is
   * an unknown outcome and is reported as such.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new McpError("config", this.serverId, "tool name is required");
    }
    const deadline = Date.now() + (opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.callTimeoutMs);
    await this.semaphore.acquire();
    try {
      await this.untilRunnable(deadline);
      const params = { name, arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {} };
      const result = await this.request("tools/call", params, deadline - Date.now(), opts.signal);
      return normalizeCallResult(result);
    } finally {
      this.semaphore.release();
    }
  }

  /** Reap the child and refuse further work. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopping) {
      await this.killChild();
      return;
    }
    this.stopping = true;
    this.stateValue = "stopped";
    this.toolsValue = [];
    // Unregister immediately: a stopped server has no callable tools, and the
    // hook (the manager wires it to the registry) is the one place that says so.
    this.emitTools([]);
    this.failAllPending(new McpTransportError(this.serverId, "client stopped"));
    await this.killChild();
  }

  /* ----------------------------- connection ----------------------------- */

  private async spawnAndHandshake(): Promise<McpToolInfo[]> {
    await this.killChild(); // a reconnect may replace a dead child that lingers
    this.buffer = "";
    this.stderrBuffer = "";
    this.pendingCalls.clear();
    const epoch = (this.epoch += 1);
    // ONE connect budget for the whole handshake, not one per request: a server
    // that answers `initialize` and then stalls on `tools/list` is not connected
    // within 2x the documented budget.
    const deadline = Date.now() + this.connectTimeoutMs;
    try {
      return await this.handshake(epoch, deadline);
    } catch (err) {
      // A failed handshake leaves no usable server behind: reap the child here,
      // so a connect that timed out cannot leave a process nobody owns.
      await this.killChild();
      throw err;
    }
  }

  private async handshake(epoch: number, deadline: number): Promise<McpToolInfo[]> {
    let proc: OwnedProc;
    try {
      ({ proc } = await spawnOwned([this.command, ...this.args], {
        stateDir: this.stateDir,
        label: `mcp: ${this.serverId}`,
        cwd: this.cwd,
        // Scrubbed base + the server's own configured values: a server gets
        // exactly what its config names, never hzcode's credentials wholesale.
        env: { ...scrubEnv(), ...this.env },
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        detached: true, // its own process group: stop() reaps the whole tree
      }));
    } catch (err) {
      throw new McpTransportError(this.serverId, `could not start ${this.command}: ${errorMessage(err)}`);
    }
    if (this.stopping) {
      await this.killChild();
      throw new McpTransportError(this.serverId, "client was stopped during connect");
    }
    this.proc = proc;
    void this.pumpStdout(proc, epoch);
    void this.pumpStderr(proc, epoch);
    void proc.exited.then(
      (code) => this.onExit(epoch, code),
      () => this.onExit(epoch, -1),
    );

    // initialize -> notifications/initialized -> tools/list, in that order.
    const initialized = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
      deadline - Date.now(),
    );
    if (initialized === null || typeof initialized !== "object") {
      throw new McpProtocolError(this.serverId, "initialize returned no object");
    }
    this.notify("notifications/initialized");
    const tools = await this.listToolsForDiscovery(deadline);
    this.toolsValue = tools;
    return tools;
  }

  /* ------------------------------ transport ------------------------------ */

  private async pumpStdout(proc: OwnedProc, epoch: number): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (epoch !== this.epoch) break; // an older child's bytes
        this.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* the stream is closed by a kill; the exit path reports the death */
    }
  }

  private async pumpStderr(proc: OwnedProc, epoch: number): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (epoch !== this.epoch) break;
        this.stderrBuffer = (this.stderrBuffer + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_CAP);
      }
    } catch {
      /* stream closed by a kill */
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "") this.handleMessage(line);
    }
  }

  /** One parsed stdout line: a response, a notification, or a server request. */
  private handleMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      this.onNotice?.(`mcp server ${this.serverId} wrote a non-JSON stdout line (kept for diagnostics)`);
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pendingCalls.get(id);
      if (!pending) return; // a response to a request we already gave up on
      this.settlePending(pending, message);
      return;
    }
    if (typeof message.method === "string") {
      if (id === undefined) {
        this.handleNotification(message.method);
        return;
      }
      // A server -> client request. v1 serves none of them; answering keeps the
      // server from blocking on it instead of hanging silently.
      void this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${message.method}` } });
      return;
    }
  }

  private handleNotification(method: string): void {
    if (method === "notifications/tools/list_changed") {
      // Best effort: one re-list so the registry's view follows the server.
      void this.refreshTools();
      return;
    }
    if (method.startsWith("notifications/") && this.onNotice !== undefined) {
      this.onNotice(`mcp server ${this.serverId}: ${method}`);
    }
  }

  private async refreshTools(): Promise<void> {
    if (this.stateValue !== "connected" || this.proc === undefined) return;
    try {
      const deadline = Date.now() + this.connectTimeoutMs;
      const tools = await this.listToolsForDiscovery(deadline);
      this.emitTools(tools);
    } catch {
      /* a failed re-list leaves the previous list; the call path reports death */
    }
  }

  /** Paginated `tools/list` until `nextCursor` is absent (shared connect + re-list path). */
  private async listToolsForDiscovery(deadline: number): Promise<McpToolInfo[]> {
    return listAllMcpTools(
      (cursor) => this.request("tools/list", mcpListRequestParams(cursor), deadline - Date.now()),
      this.serverId,
    );
  }

  /**
   * Paginated `resources/list` until `nextCursor` is absent (discovery consumer;
   * ruling 264). Fails when the transport is not connected.
   */
  async listResources(opts?: { timeoutMs?: number }): Promise<McpResourceInfo[]> {
    if (this.stopping) throw new McpTransportError(this.serverId, "listResources: client was stopped");
    if (this.stateValue !== "connected" || this.proc === undefined) {
      throw new McpTransportError(this.serverId, "listResources: not connected");
    }
    const budget = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.connectTimeoutMs;
    const deadline = Date.now() + budget;
    return listAllMcpResources(
      (cursor) => this.request("resources/list", mcpListRequestParams(cursor), deadline - Date.now()),
      this.serverId,
    );
  }

  private settlePending(pending: PendingCall, message: Record<string, unknown>): void {
    if ("error" in message && message.error !== null && message.error !== undefined) {
      const error = message.error as { code?: unknown; message?: unknown };
      const code = typeof error.code === "number" ? error.code : undefined;
      const text = typeof error.message === "string" ? error.message : safeJson(error);
      pending.reject(new McpRpcError(this.serverId, code, `${pending.method}: ${text}`));
      return;
    }
    pending.resolve(message.result);
  }

  /** One request/response round trip; `timeoutMs` is the caller's remaining budget. */
  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const proc = this.proc;
    if (proc === undefined || this.stopping || this.stateValue === "stopped") {
      return Promise.reject(new McpTransportError(this.serverId, `${method}: no live transport`));
    }
    if (signal?.aborted) return Promise.reject(new McpAbortedError(this.serverId, `${method}: aborted`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const finish = (settle: () => void): void => {
        if (done) return;
        done = true;
        this.pendingCalls.delete(id);
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = (): void => finish(() => reject(new McpAbortedError(this.serverId, `${method}: aborted`)));
      const timer = setTimeout(() => {
        finish(() => reject(new McpTimeoutError(this.serverId, `${method}: no response within ${Math.max(1, Math.floor(timeoutMs))}ms`)));
      }, Math.max(1, Math.floor(timeoutMs)));
      const pending: PendingCall = {
        resolve: (value) => finish(() => resolve(value)),
        reject: (err) => finish(() => reject(err)),
        method,
      };
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      this.pendingCalls.set(id, pending);
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        const current = this.pendingCalls.get(id);
        if (current === undefined) return;
        current.reject(err instanceof McpError ? err : new McpTransportError(this.serverId, errorMessage(err)));
      });
    });
  }

  /** Write one JSON-RPC frame; a dead sink is a typed transport failure. */
  private async write(message: Record<string, unknown>): Promise<void> {
    const proc = this.proc;
    if (proc === undefined || this.stopping) {
      throw new McpTransportError(this.serverId, "no live transport");
    }
    const sink = proc.stdin as unknown as { write(data: string): unknown; flush?: () => Promise<number> | void };
    try {
      sink.write(`${JSON.stringify(message)}\n`);
      // Bun's stdin is a FileSink: without a flush a small init frame can sit
      // buffered forever and the server never answers.
      await sink.flush?.();
    } catch (err) {
      throw new McpTransportError(this.serverId, `write failed: ${errorMessage(err)}`);
    }
  }

  private notify(method: string, params?: unknown): void {
    void this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }).catch((err) => {
      this.onNotice?.(`mcp server ${this.serverId}: ${errorMessage(err)}`);
    });
  }

  /* ------------------------- death and reconnection ------------------------- */

  private onExit(epoch: number, code: number): void {
    if (epoch !== this.epoch) return; // an older child we already replaced
    this.proc = undefined;
    if (this.stopping) return;
    const reason = `server exited (code ${code})`;
    const error = new McpTransportError(this.serverId, `${reason} mid-transport`);
    this.failAllPending(error);
    this.toolsValue = [];
    // The server's tools are unreachable the moment it dies; a successful
    // reconnect re-lists and re-registers them (onTools), more may follow.
    this.emitTools([]);
    if (this.stateValue === "down") return; // already given up; nothing to do
    this.stateValue = "reconnecting";
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTask !== undefined || this.stopping) return;
    const task = (async (): Promise<void> => {
      let lastError: McpError | undefined;
      for (let attempt = 1; attempt <= this.maxReconnects; attempt += 1) {
        this.reconnectAttemptsValue = attempt;
        const delay = this.reconnectBaseMs * 2 ** (attempt - 1);
        this.onNotice?.(`mcp server ${this.serverId}: ${reason}; reconnect ${attempt}/${this.maxReconnects} in ${delay}ms`);
        await sleep(delay);
        if (this.stopping) {
          this.reconnectTask = undefined;
          return;
        }
        try {
          const tools = await this.spawnAndHandshake();
          this.stateValue = "connected";
          this.reconnectTask = undefined;
          this.emitTools(tools);
          this.onNotice?.(`mcp server ${this.serverId} is back (${tools.length} tool(s) after ${attempt} reconnect attempt(s))`);
          return;
        } catch (err) {
          lastError = err instanceof McpError ? err : new McpTransportError(this.serverId, errorMessage(err));
        }
      }
      this.reconnectTask = undefined;
      if (this.stopping) return;
      this.markDown(
        new McpServerDownError(
          this.serverId,
          `${reason}; ${this.maxReconnects} reconnect attempt(s) failed — last error: ${lastError?.message ?? "unknown"}`,
        ),
      );
    })();
    this.reconnectTask = task;
    void task.catch(() => undefined);
  }

  private markDown(error: McpServerDownError): void {
    this.stateValue = "down";
    this.downErrorValue = error;
    this.toolsValue = [];
    this.emitTools([]);
    try {
      this.onDown?.(this.serverId, error);
    } catch {
      /* a hook failure must not break the client */
    }
    this.onNotice?.(`mcp server ${this.serverId} is down: ${error.message}`);
    for (const resolve of this.downWaiters.splice(0)) resolve(error);
  }

  /** Wait until the transport is usable again, or fail with the deadline. */
  private async untilRunnable(deadline: number): Promise<void> {
    for (;;) {
      const state = this.stateValue;
      if (state === "connected") return;
      if (state === "down") throw this.downErrorValue ?? new McpServerDownError(this.serverId, "server is down");
      if (state === "stopped" || this.stopping) throw new McpTransportError(this.serverId, "client was stopped");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new McpTimeoutError(this.serverId, "timed out waiting for the server to become callable");
      }
      // Poll the state at 25 ms: the reconnect task always terminates (bounded
      // attempts), and this call's own deadline bounds the wait either way.
      await sleep(Math.min(25, remaining));
    }
  }

  private failAllPending(error: McpError): void {
    const pending = [...this.pendingCalls.values()];
    this.pendingCalls.clear();
    for (const call of pending) call.reject(error);
  }

  private emitTools(tools: McpToolInfo[]): void {
    try {
      this.onTools?.(this.serverId, tools);
    } catch {
      /* a hook failure must not break the client */
    }
  }

  private async killChild(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc === undefined) return;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-proc.pid, sig); // the child's process group (detached)
      } catch {
        try {
          proc.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    try {
      (proc.stdin as unknown as { end?: () => void })?.end?.();
    } catch {
      /* already closed */
    }
    signal("SIGTERM");
    await sleep(KILL_GRACE_MS);
    let alive = true;
    try {
      process.kill(proc.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      signal("SIGKILL");
      // Bounded wait so stop() really has reaped the child before it returns.
      await Promise.race([proc.exited.catch(() => undefined), sleep(1_000)]);
    }
  }
}

/* -------------------------------- parsing -------------------------------- */

/** Map one `tools/list` result to the reduced tool shape; junk entries are skipped. */
export function parseResourcesList(result: unknown, serverId: string): McpResourceInfo[] {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new McpProtocolError(serverId, "resources/list returned no object");
  }
  const list = (result as { resources?: unknown }).resources;
  if (!Array.isArray(list)) throw new McpProtocolError(serverId, "resources/list did not return a resources array");
  const out: McpResourceInfo[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const uri = typeof raw.uri === "string" ? raw.uri.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (uri === "" || name === "") continue;
    out.push({
      uri,
      name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    });
  }
  return out;
}

export function parseToolsList(result: unknown, serverId: string): McpToolInfo[] {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new McpProtocolError(serverId, "tools/list returned no object");
  }
  const list = (result as { tools?: unknown }).tools;
  if (!Array.isArray(list)) throw new McpProtocolError(serverId, "tools/list did not return a tools array");
  const tools: McpToolInfo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "" || seen.has(name)) continue; // unnamed/duplicate claims are not callable
    seen.add(name);
    const annotations =
      raw.annotations !== null && typeof raw.annotations === "object" && !Array.isArray(raw.annotations)
        ? (raw.annotations as Record<string, unknown>)
        : undefined;
    const hint = annotations?.readOnlyHint;
    tools.push({
      name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      inputSchema:
        raw.inputSchema !== null && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema)
          ? (raw.inputSchema as Record<string, unknown>)
          : undefined,
      readOnlyHint: typeof hint === "boolean" ? hint : undefined,
    });
  }
  return tools;
}

/** Reduce a `tools/call` result to `{isError, text, raw}`. */
export function normalizeCallResult(result: unknown): McpCallResult {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { isError: false, text: safeJson(result), raw: result };
  }
  const record = result as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) {
        parts.push(safeJson(part));
        continue;
      }
      const item = part as Record<string, unknown>;
      if (typeof item.text === "string") parts.push(item.text);
      else parts.push(safeJson(item));
    }
  }
  if (parts.length === 0) parts.push(safeJson(result));
  return { isError: record.isError === true, text: parts.join("\n"), raw: result };
}

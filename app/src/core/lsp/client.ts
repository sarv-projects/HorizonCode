/**
 * client.ts — a single-server LSP client over stdio (reduced form).
 *
 * One server, one child process, Content-Length framed JSON-RPC 2.0 on its
 * stdin/stdout. This is the transport + handshake + diagnostics half of the LSP
 * surface, mirroring the MCP client (core/mcp/client.ts) in discipline while
 * speaking the LSP wire shape (framing.ts) instead of newline frames.
 *
 * SPAWN DISCIPLINE (the rule enforced before any process exists):
 *  - `lspSpawnAction(server)` is the admission a start performs — a `spawn`
 *    GuardAction naming exactly which program, digested like code_mode/mcp:
 *    `lsp <id> <sha256(canonicalJson({command,args}))[0..16]>`. `env` is NOT in
 *    the digest (a configured secret must not enter approval text).
 *  - `connect()` calls the supplied guard hook FIRST. A `deny` skips the spawn
 *    with a reason; an `ask` routes to `approve` and skips if declined. Only an
 *    allow (or an approved ask) reaches the spawn.
 *  - the spawn itself goes through `spawnOwned` (NF-071: the one spawn path) —
 *    never a raw `Bun.spawn`. The child is ledgered and dies with its owner.
 *
 * Handshake: `initialize` (announcing didSave sync + publishDiagnostics
 * versionSupport) -> `initialized` notification. Then `didOpen`/`didChange`/
 * `didSave` drive the document, each `didChange` bumping a per-uri version, and
 * `textDocument/publishDiagnostics` notifications are collected keyed by uri
 * with the version the server stamped on them.
 *
 * FRESHNESS is by EXACT document-version match: `waitForDiagnostics(uri,
 * version, budget)` resolves with the publish whose version equals the
 * post-edit document version, never a stale earlier one, bounded by a timeout.
 *
 * GRACEFUL DEGRADE: a command that is not found, a spawn that fails, or a
 * handshake that times out leaves the client in a typed `unavailable` state —
 * the mux/writethrough treat that as a no-op and never throw to the tool. The
 * child, if any, is reaped so a failed connect leaves nothing behind.
 */

import type { ApprovalRequest, GuardAction, GuardDecision } from "../../contracts";
import { scrubEnv } from "../../tools/helpers";
import { canonicalJson, sha256Hex } from "../canon";
import type { LspServerConfig } from "../config";
import { spawnOwned, type OwnedProc } from "../owned-spawn";
import { encodeMessage, LspFramer } from "./framing";
import type { Diagnostic, PublishDiagnosticsParams } from "./types";

/** The LSP client name/version announced in `initialize`. */
export const LSP_CLIENT_NAME = "hzcode";
export const LSP_CLIENT_VERSION = "0.1.0";
/** The whole-handshake budget (initialize + initialized). */
export const LSP_CONNECT_TIMEOUT_MS = 10_000;
/** One request/response round trip budget. */
export const LSP_REQUEST_TIMEOUT_MS = 10_000;
/** SIGTERM -> SIGKILL grace when reaping a child. */
const KILL_GRACE_MS = 300;
/** Byte cap on the stderr tail kept for diagnostics. */
const STDERR_TAIL_CAP = 4_000;

/**
 * The guard/approval seam the client uses, backed by the host's
 * `ctx.guard`/`ctx.approve` (same shape the MCP manager uses).
 */
export interface LspGuardHooks {
  guard: (action: GuardAction) => Promise<GuardDecision>;
  approve: (req: ApprovalRequest, action?: GuardAction) => Promise<boolean>;
  onNotice?: (message: string) => void;
}

/**
 * The spawn admission a start performs: one `spawn` for the program, naming
 * exactly which one. The digest mirrors mcpSpawnAction (command+args only; env
 * excluded on purpose) so the two surfaces admit spawns identically.
 */
export function lspSpawnAction(server: LspServerConfig): GuardAction {
  const programDigest = sha256Hex(canonicalJson({ command: server.command, args: server.args ?? [] })).slice(0, 16);
  return { kind: "spawn", target: `lsp ${server.id} ${programDigest}` };
}

/** Why a connect did not yield a live, handshaked client. */
export type LspUnavailableReason = "denied" | "declined" | "guard-error" | "spawn-failed" | "handshake-failed";

/** The client's lifecycle state; `unavailable` is the graceful-degrade terminal. */
export type LspClientState = "idle" | "connecting" | "connected" | "unavailable" | "stopped";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A diagnostics publish, as collected per uri. */
interface CollectedPublish {
  version: number | null;
  diagnostics: Diagnostic[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/** A waiter for a publish whose version matches an expected document version. */
interface VersionWaiter {
  uri: string;
  version: number;
  resolve: (diagnostics: Diagnostic[]) => void;
}

export interface LspClientOptions {
  server: LspServerConfig;
  workspace: string;
  cwd: string;
  /** Where the spawn ledger lives: `<stateDir>/spawns.jsonl`. */
  stateDir: string;
  hooks: LspGuardHooks;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * One LSP server over stdio. `connect()` admits + spawns + handshakes; it never
 * throws for a server-level failure, it returns false and parks the client in
 * `unavailable`. `stop()` reaps the child.
 */
export class LspClient {
  readonly serverId: string;
  private readonly server: LspServerConfig;
  private readonly workspace: string;
  private readonly cwd: string;
  private readonly stateDir: string;
  private readonly hooks: LspGuardHooks;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private proc: OwnedProc | undefined;
  private readonly framer: LspFramer;
  private stderrBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stateValue: LspClientState = "idle";
  private unavailableReasonValue: LspUnavailableReason | undefined;
  private capabilities: Record<string, unknown> = {};
  /** Per-uri monotonic document version; didOpen=1, each didChange increments. */
  private readonly versions = new Map<string, number>();
  /** The latest publish per uri. */
  private readonly published = new Map<string, CollectedPublish>();
  private readonly versionWaiters: VersionWaiter[] = [];
  private stopping = false;

  constructor(opts: LspClientOptions) {
    this.server = opts.server;
    this.serverId = opts.server.id;
    this.workspace = opts.workspace;
    this.cwd = opts.cwd;
    this.stateDir = opts.stateDir;
    this.hooks = opts.hooks;
    this.connectTimeoutMs = opts.connectTimeoutMs && opts.connectTimeoutMs > 0 ? opts.connectTimeoutMs : LSP_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs && opts.requestTimeoutMs > 0 ? opts.requestTimeoutMs : LSP_REQUEST_TIMEOUT_MS;
    this.framer = new LspFramer((message) => this.hooks.onNotice?.(`lsp[${this.serverId}]: ${message}`));
  }

  get state(): LspClientState {
    return this.stateValue;
  }

  /** The reason a connect did not produce a live client, when unavailable. */
  get unavailableReason(): LspUnavailableReason | undefined {
    return this.unavailableReasonValue;
  }

  /** The live child's pid, or undefined when nothing is running. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** The server's `initialize` capabilities (feature detection; {} until connected). */
  get serverCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  /** Recent stderr from the child, for diagnostics only. */
  stderrTail(): string {
    return this.stderrBuffer;
  }

  /**
   * Admit, spawn and handshake. Resolves true when the client is connected,
   * false when it degraded to `unavailable` (the mux treats false as no-op).
   * NEVER throws for a server-level failure.
   */
  async connect(): Promise<boolean> {
    if (this.stopping) return false;
    if (this.stateValue === "connected") return true;
    this.stateValue = "connecting";

    // 1. The spawn admission, before any process exists.
    const action = lspSpawnAction(this.server);
    let decision: GuardDecision;
    try {
      decision = await this.hooks.guard(action);
    } catch (err) {
      return this.degrade("guard-error", `guard unavailable (${errorMessage(err)})`);
    }
    if (decision.decision === "deny") {
      return this.degrade("denied", `DENIED by policy (${decision.reason ?? action.kind})`);
    }
    if (decision.decision === "ask") {
      let approved = false;
      try {
        approved = await this.hooks.approve(
          { title: `start language server ${this.serverId}`, detail: action.target, kind: action.kind },
          action,
        );
      } catch {
        approved = false;
      }
      if (!approved) return this.degrade("declined", "DECLINED by the user");
    }

    // 2. The spawn, through the one owned path.
    try {
      ({ proc: this.proc } = await spawnOwned([this.server.command, ...(this.server.args ?? [])], {
        stateDir: this.stateDir,
        label: `lsp: ${this.serverId}`,
        cwd: this.cwd,
        env: { ...scrubEnv(), ...this.server.env },
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        detached: true,
      }));
    } catch (err) {
      return this.degrade("spawn-failed", `could not start ${this.server.command}: ${errorMessage(err)}`);
    }

    void this.pumpStdout(this.proc);
    void this.pumpStderr(this.proc);
    const proc = this.proc;
    void proc.exited.then(
      () => this.onExit(),
      () => this.onExit(),
    );

    // 3. The handshake, bounded by the connect budget.
    const deadline = Date.now() + this.connectTimeoutMs;
    try {
      const result = await this.request(
        "initialize",
        {
          processId: typeof process.pid === "number" ? process.pid : null,
          rootUri: pathToFileUri(this.cwd),
          capabilities: {
            textDocument: {
              synchronization: { didSave: true, dynamicRegistration: false },
              publishDiagnostics: { versionSupport: true },
            },
          },
          clientInfo: { name: LSP_CLIENT_NAME, version: LSP_CLIENT_VERSION },
        },
        deadline - Date.now(),
      );
      if (result !== null && typeof result === "object") {
        const caps = (result as { capabilities?: unknown }).capabilities;
        this.capabilities = caps !== null && typeof caps === "object" && !Array.isArray(caps) ? (caps as Record<string, unknown>) : {};
      }
      this.notify("initialized", {});
      this.stateValue = "connected";
      return true;
    } catch (err) {
      await this.killChild();
      return this.degrade("handshake-failed", `handshake failed: ${errorMessage(err)}`);
    }
  }

  /** True when the server advertises a `workspace/executeCommand` for `command`. */
  supportsExecuteCommand(command: string): boolean {
    const provider = this.capabilities.executeCommandProvider;
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
    const commands = (provider as { commands?: unknown }).commands;
    return Array.isArray(commands) && commands.includes(command);
  }

  /** Send a `workspace/executeCommand`; returns the result or throws on timeout/death. */
  async executeCommand(command: string, args: unknown[]): Promise<unknown> {
    return await this.request("workspace/executeCommand", { command, arguments: args }, this.requestTimeoutMs);
  }

  /** Open a document; its version starts at 1. */
  didOpen(uri: string, languageId: string, text: string): void {
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  /** Full-content change; returns the new (incremented) document version. */
  didChange(uri: string, text: string): number {
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return version;
  }

  /** Signal a save; servers commonly (re)compute diagnostics on save. */
  didSave(uri: string, text?: string): void {
    this.notify("textDocument/didSave", {
      textDocument: { uri },
      ...(text === undefined ? {} : { text }),
    });
  }

  /** The current document version tracked for a uri (0 when never opened). */
  documentVersion(uri: string): number {
    return this.versions.get(uri) ?? 0;
  }

  /**
   * Resolve with the diagnostics of the publish whose version EXACTLY matches
   * `expectedVersion` (freshness), bounded by `budgetMs`. If a matching publish
   * already arrived it resolves immediately; otherwise it waits, and on timeout
   * resolves with an empty array (graceful: the writethrough treats no-fresh as
   * `no issues`, never a throw).
   */
  async waitForDiagnostics(uri: string, expectedVersion: number, budgetMs: number): Promise<Diagnostic[]> {
    const already = this.published.get(uri);
    if (already !== undefined && already.version === expectedVersion) {
      return already.diagnostics;
    }
    const waiter: VersionWaiter = { uri, version: expectedVersion, resolve: () => undefined };
    const { promise, resolve } = deferred<Diagnostic[]>();
    waiter.resolve = resolve;
    this.versionWaiters.push(waiter);
    const timer = setTimeout(() => {
      const index = this.versionWaiters.indexOf(waiter);
      if (index >= 0) this.versionWaiters.splice(index, 1);
      resolve([]);
    }, Math.max(1, Math.floor(budgetMs)));
    const result = await promise;
    clearTimeout(timer);
    return result;
  }

  /** Reap the child and refuse further work. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.stateValue !== "unavailable") this.stateValue = "stopped";
    this.failAllPending(new Error(`lsp[${this.serverId}]: client stopped`));
    for (const waiter of this.versionWaiters.splice(0)) waiter.resolve([]);
    await this.killChild();
  }

  /* ----------------------------- internals ----------------------------- */

  private degrade(reason: LspUnavailableReason, detail: string): boolean {
    this.stateValue = "unavailable";
    this.unavailableReasonValue = reason;
    this.hooks.onNotice?.(`lsp: server ${this.serverId} unavailable — ${detail}`);
    return false;
  }

  private async pumpStdout(proc: OwnedProc): Promise<void> {
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        this.framer.push(value);
        for (const message of this.framer.drain()) this.handleMessage(message);
      }
    } catch {
      /* stream closed by a kill; the exit path reports the death */
    }
  }

  private async pumpStderr(proc: OwnedProc): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        this.stderrBuffer = (this.stderrBuffer + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_CAP);
      }
    } catch {
      /* stream closed by a kill */
    }
  }

  private handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const msg = message as Record<string, unknown>;
    const id = typeof msg.id === "number" ? msg.id : undefined;
    if (id !== undefined && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if ("error" in msg && msg.error !== null && msg.error !== undefined) {
        const error = msg.error as { message?: unknown };
        pending.reject(new Error(`${pending.method}: ${typeof error.message === "string" ? error.message : "rpc error"}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      if (id === undefined) {
        this.handleNotification(msg.method, msg.params);
        return;
      }
      // A server -> client request. v1 serves none; answer so the server does
      // not block waiting on us.
      void this.writeRaw({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return;
    const p = params as PublishDiagnosticsParams;
    if (typeof p.uri !== "string") return;
    const version = typeof p.version === "number" ? p.version : null;
    const diagnostics = Array.isArray(p.diagnostics) ? p.diagnostics : [];
    this.published.set(p.uri, { version, diagnostics });
    // Wake any waiter whose expected version matches exactly.
    for (let i = this.versionWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.versionWaiters[i] as VersionWaiter;
      if (waiter.uri === p.uri && version === waiter.version) {
        this.versionWaiters.splice(i, 1);
        waiter.resolve(diagnostics);
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const proc = this.proc;
    if (proc === undefined || this.stopping) {
      return Promise.reject(new Error(`lsp[${this.serverId}]: ${method}: no live transport`));
    }
    const id = this.nextId++;
    const { promise, resolve, reject } = deferred<unknown>();
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      this.pending.delete(id);
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`lsp[${this.serverId}]: ${method}: no response within ${Math.max(1, Math.floor(timeoutMs))}ms`)));
    }, Math.max(1, Math.floor(timeoutMs)));
    this.pending.set(id, {
      resolve: (value) => finish(() => resolve(value)),
      reject: (err) => finish(() => reject(err)),
      method,
    });
    void this.writeRaw({ jsonrpc: "2.0", id, method, params }).catch((err) => {
      const current = this.pending.get(id);
      if (current !== undefined) current.reject(err instanceof Error ? err : new Error(String(err)));
    });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    void this.writeRaw({ jsonrpc: "2.0", method, params }).catch((err) => {
      this.hooks.onNotice?.(`lsp[${this.serverId}]: ${method}: ${errorMessage(err)}`);
    });
  }

  private async writeRaw(message: Record<string, unknown>): Promise<void> {
    const proc = this.proc;
    if (proc === undefined || this.stopping) throw new Error(`lsp[${this.serverId}]: no live transport`);
    const sink = proc.stdin as unknown as { write(data: Uint8Array): unknown; flush?: () => Promise<number> | void };
    try {
      sink.write(encodeMessage(message));
      await sink.flush?.();
    } catch (err) {
      throw new Error(`lsp[${this.serverId}]: write failed: ${errorMessage(err)}`);
    }
  }

  private onExit(): void {
    this.proc = undefined;
    if (this.stopping) return;
    this.failAllPending(new Error(`lsp[${this.serverId}]: server exited mid-transport`));
    for (const waiter of this.versionWaiters.splice(0)) waiter.resolve([]);
    if (this.stateValue === "connected" || this.stateValue === "connecting") {
      this.stateValue = "unavailable";
      this.unavailableReasonValue = "handshake-failed";
    }
  }

  private failAllPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) call.reject(error);
  }

  private async killChild(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc === undefined) return;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-proc.pid, sig);
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
      await Promise.race([proc.exited.catch(() => undefined), sleep(1_000)]);
    }
  }
}

/** A promise with externally callable resolve/reject (no captured lambda state). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `file://` URI for an absolute path (minimal; enough for the fixtures). */
export function pathToFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}

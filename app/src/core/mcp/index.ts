/**
 * index.ts — the MCP manager (docs/09 §4.7 / R-tools-18/19/33, reduced form).
 *
 * One manager per runtime. `start(config, hooks)` connects every server named in
 * the config and registers its tools through the registry seam, so the model's
 * dispatch (`getTool`/`toolSpecs`) sees them like any other tool while policy
 * still decides each call as `mcp.invoke`. `stop()` reaps every child this
 * manager started, whatever state it is in.
 *
 * The one rule this module enforces before any server runs (mirroring
 * code_mode's spawn admission): starting a server is a `spawn`, and the
 * admission target names exactly which program —
 * `mcp <serverId> <sha256(command, args)[0..16]>` (the same reduced digest form
 * loop.ts uses for `code_mode`). Without it, adding an MCP server to a config
 * file would be a spawn path that never asked. `env` values are deliberately
 * NOT in the digest: a configured secret must not enter approval text or a
 * policy target. The check runs BEFORE the spawn; deny and decline both skip
 * the server, and the leftover entry is noticed, never silent.
 *
 * Reduced form, stated honestly, because the holes are the interesting part:
 *
 *  - User-config servers are always eligible. Workspace `mcp.json` merges only
 *    when digests match `trust.json` (rulings 105/113); an untrusted workspace
 *    cannot name a program that would then run with the user's authority.
 *  - A malformed entry is skipped with a notice; a failed connect is skipped
 *    with a notice. Neither stops the session.
 *  - `start` does not retry a failed initial connect: the human named the
 *    program, and a background retry of a program that never started is a
 *    surprise. A server that connected and later died gets the bounded
 *    in-client reconnect ladder (client.ts), not this loop.
 *  - A DOWN server's tools are unregistered (the client reports an empty list);
 *    a successful reconnect re-registers them. There is no tool-call replay.
 */

import type { ApprovalRequest, GuardAction, GuardDecision } from "../../contracts";
import { canonicalJson, sha256Hex } from "../canon";
import { parseMcpServer, type McpConfig, type McpServerConfig } from "../config";
import { kernelStateDir } from "../owned-spawn";
import { McpClient, type McpClientOptions } from "./client";
import { clearMcpTools, registerMcpTools } from "./registry";
/** What a manager needs from its host session. */
export interface McpManagerHooks {
  workspace: string;
  sessionId: string;
  /** When set, an present but untrusted workspace `mcp.json` emits a notice (v1 does not load it). */
  trustedWorkspaceHooks?: readonly string[];
  home?: string;
  /** The host's guard (the session's GuardGate, or the kernel client directly). */
  guard: (action: GuardAction) => Promise<GuardDecision>;
  /** The host's approval handler; `action` names what is being approved. */
  approve: (req: ApprovalRequest, action?: GuardAction) => Promise<boolean>;
  onNotice: (message: string) => void;
}

/** Injectable limits/factory, for tests. */
export interface McpManagerOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxInFlight?: number;
  maxReconnects?: number;
  reconnectBaseMs?: number;
  /** Builds the client; tests substitute a fake transport here. */
  clientFactory?: (opts: McpClientOptions) => McpClient;
}

export type McpServerState = "connected" | "failed" | "down" | "stopped";

export interface McpServerReport {
  serverId: string;
  state: McpServerState;
  tools: number;
  /** Set when the server never connected, or went down. */
  reason?: string;
}

interface ServerRecord {
  config: McpServerConfig;
  client: McpClient | undefined;
  state: McpServerState;
  reason: string | undefined;
  /** The registered tool count at the last update, for the report. */
  tools: number;
}

/**
 * The admission a connect performs, per server: one `spawn` for the program,
 * naming exactly which one. The target is the mirror of code_mode's
 * `spawn code_mode <digest16>` — same kind, same digest length, same
 * fail-closed shape when the guard is unreachable.
 */
export function mcpSpawnAction(server: McpServerConfig): GuardAction {
  const programDigest = sha256Hex(canonicalJson({ command: server.command, args: server.args ?? [] })).slice(0, 16);
  return { kind: "spawn", target: `mcp ${server.id} ${programDigest}` };
}

export class McpManager {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly opts: McpManagerOptions;
  private hooks: McpManagerHooks | undefined;
  private started = false;

  constructor(opts: McpManagerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Connect every configured server and register its tools. Never throws for a
   * server-level failure: each one becomes a notice and a report entry.
   */
  async start(config: McpConfig | undefined, hooks: McpManagerHooks): Promise<McpManager> {
    if (this.started) return this;
    this.started = true;
    this.hooks = hooks;
    const servers = Array.isArray(config?.servers) ? config.servers : [];
    for (const reason of config?.rejected ?? []) {
      hooks.onNotice(`mcp: skipped a malformed server entry — ${reason}`);
    }
    if (servers.length === 0) return this;
    let index = 0;
    for (const value of servers) {
      // Re-validate defensively: the manager may be started with a hand-built
      // config object, and a bad entry must be a skip, never a crash.
      const parsed = parseMcpServer(value, index);
      index += 1;
      if (typeof parsed === "string") {
        hooks.onNotice(`mcp: skipped a malformed server entry — ${parsed}`);
        continue;
      }
      if (this.servers.has(parsed.id)) {
        hooks.onNotice(`mcp: skipped server ${parsed.id}: a server with that id is already configured`);
        continue;
      }
      await this.connectServer(parsed, hooks);
    }
    return this;
  }

  private async connectServer(server: McpServerConfig, hooks: McpManagerHooks): Promise<void> {
    const record: ServerRecord = { config: server, client: undefined, state: "failed", reason: undefined, tools: 0 };
    this.servers.set(server.id, record);

    // 1. The spawn admission, before any process exists.
    const action = mcpSpawnAction(server);
    let decision: GuardDecision;
    try {
      decision = await hooks.guard(action);
    } catch (err) {
      record.reason = `guard unavailable (${err instanceof Error ? err.message : String(err)})`;
      hooks.onNotice(`mcp: server ${server.id} not started — ${record.reason}`);
      return;
    }
    if (decision.decision === "deny") {
      record.reason = `DENIED by policy (${decision.reason ?? action.kind})`;
      hooks.onNotice(`mcp: server ${server.id} not started — ${record.reason}`);
      return;
    }
    if (decision.decision === "ask") {
      let approved = false;
      try {
        approved = await hooks.approve(
          { title: `start MCP server ${server.id}`, detail: action.target, kind: action.kind },
          action,
        );
      } catch {
        approved = false;
      }
      if (!approved) {
        record.reason = "DECLINED by the user";
        hooks.onNotice(`mcp: server ${server.id} not started — ${record.reason}`);
        return;
      }
    }

    // 2. The client. Its tool list is the registry's only source of tools:
    //    registration on every change (connect, list_changed, death, reconnect)
    //    keeps the visible set equal to what the server claims right now.
    const factory = this.opts.clientFactory ?? ((opts: McpClientOptions) => new McpClient(opts));
    let client: McpClient;
    try {
      client = factory({
        serverId: server.id,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        stateDir: kernelStateDir(hooks.workspace),
        connectTimeoutMs: this.opts.connectTimeoutMs,
        callTimeoutMs: this.opts.callTimeoutMs,
        maxInFlight: this.opts.maxInFlight,
        maxReconnects: this.opts.maxReconnects,
        reconnectBaseMs: this.opts.reconnectBaseMs,
        onTools: (_serverId, tools) => {
          registerMcpTools(server.id, tools, client);
          record.tools = tools.length;
          if (tools.length === 0 && record.state === "connected") {
            // The list came back empty without a death: the server says it has
            // nothing callable now. Name it rather than silently showing none.
            hooks.onNotice(`mcp: server ${server.id} listed no callable tools`);
          }
        },
        onDown: (_serverId, error) => {
          record.state = "down";
          record.reason = error.message;
          hooks.onNotice(`mcp: server ${server.id} is down — ${error.message}`);
        },
        onNotice: (message) => hooks.onNotice(message),
      });
    } catch (err) {
      record.reason = err instanceof Error ? err.message : String(err);
      hooks.onNotice(`mcp: server ${server.id} not started — ${record.reason}`);
      return;
    }
    record.client = client;

    try {
      await client.connect();
      record.state = "connected";
      record.reason = undefined;
      hooks.onNotice(`mcp: server ${server.id} connected (${client.tools.length} tool(s))`);
    } catch (err) {
      record.reason = err instanceof Error ? err.message : String(err);
      hooks.onNotice(`mcp: server ${server.id} failed to connect — ${record.reason}`);
      // A client that never connected still owns a child if the handshake died
      // halfway: reaping here is what keeps a half-started server out of the
      // process table.
      try {
        await client.stop();
      } catch {
        /* already gone */
      }
    }
  }

  /** The per-server outcomes, for a status surface or a test. */
  report(): McpServerReport[] {
    return [...this.servers.values()].map((record) => {
      const out: McpServerReport = { serverId: record.config.id, state: record.state, tools: record.tools };
      if (record.reason !== undefined) out.reason = record.reason;
      return out;
    });
  }

  /** True when every configured server connected (vacuously true with none). */
  allConnected(): boolean {
    return [...this.servers.values()].every((record) => record.state === "connected");
  }

  /** Pids of the live server children, for the reaping test. */
  pids(): number[] {
    const out: number[] = [];
    for (const record of this.servers.values()) {
      const pid = record.client?.pid;
      if (pid !== undefined) out.push(pid);
    }
    return out;
  }

  /** One server's client, for tests and for a future `/mcp` status command. */
  clientFor(serverId: string): McpClient | undefined {
    return this.servers.get(serverId)?.client;
  }

  /**
   * Reap every child and unregister every tool this manager registered.
   * Idempotent; safe to call from a runtime's close().
   */
  async stop(): Promise<void> {
    const records = [...this.servers.values()];
    const stops: Array<Promise<void>> = [];
    for (const record of records) {
      record.state = "stopped";
      if (record.client !== undefined) stops.push(record.client.stop());
      clearMcpTools(record.config.id);
    }
    await Promise.all(stops.map((promise) => promise.catch(() => undefined)));
    this.servers.clear();
  }
}

/** One-liner for a host that wants the manager without importing the class. */
export async function startMcpManager(
  config: McpConfig | undefined,
  hooks: McpManagerHooks,
  opts: McpManagerOptions = {},
): Promise<McpManager> {
  return await new McpManager(opts).start(config, hooks);
}

export {
  McpClient,
  McpError,
  McpTransportError,
  McpTimeoutError,
  McpProtocolError,
  McpRpcError,
  McpServerDownError,
  McpAbortedError,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_IN_FLIGHT,
  MCP_MAX_RECONNECTS,
  MCP_PROTOCOL_VERSION,
} from "./client";
export type { McpCallResult, McpClientOptions, McpResourceInfo, McpToolCaller, McpToolInfo } from "./client";
export {
  registerMcpTools,
  clearMcpTools,
  mcpToolSpecs,
  getMcpTool,
  isMcpToolName,
  mcpAdmissionFor,
  mcpToolName,
  fenceMcpData,
  fenceMcpResult,
  MCP_FENCE_OPEN,
  MCP_FENCE_CLOSE,
  MCP_TOOL_PREFIX,
  MCP_SERVER_ID_SLUG,
  listAllMcpTools,
  listAllMcpResources,
  mcpListRequestParams,
  parseMcpListNextCursor,
  MCP_LIST_MAX_PAGES,
} from "./registry";
export type { ListAllMcpListOptions, ListAllMcpToolsOptions } from "./registry";

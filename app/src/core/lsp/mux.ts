/**
 * mux.ts — a small multi-server LSP mux.
 *
 * Given the LspConfig and a file, select the servers that handle it
 * (lspServersForFile, FEAT-002), start OR reuse one client per
 * `(serverId, workspace)` through the guard + spawnOwned path, and hand the
 * callers the live clients. The registry is process-global, like the MCP one, so
 * a second diagnostics call over the same file reuses the already-handshaked
 * server rather than re-spawning (and re-asking the guard).
 *
 * `shutdownAll()` reaps every client this process started — asserted in tests
 * via the spawn ledger / pid liveness, not the mux's own word.
 *
 * A file with no configured server yields `undefined`: the writethrough turns
 * that into a graceful no-op.
 */

import { lspServersForFile, type LspConfig, type LspServerConfig } from "../config";
import { kernelStateDir } from "../owned-spawn";
import { LspClient, type LspGuardHooks } from "./client";

/** The process-global client registry, keyed by `<workspace>\0<serverId>`. */
const CLIENTS = new Map<string, LspClient>();

function clientKey(workspace: string, serverId: string): string {
  return `${workspace}\u0000${serverId}`;
}

export interface MuxContext {
  workspace: string;
  cwd: string;
  config: LspConfig | undefined;
  hooks: LspGuardHooks;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Start or reuse the clients for every server that handles `absPath`. Returns
 * only the clients that are CONNECTED (an unavailable one is dropped so the
 * caller sees a no-op, never a throw). Returns undefined when no server is
 * configured for the file's extension.
 */
export async function clientsForFile(ctx: MuxContext, absPath: string): Promise<LspClient[] | undefined> {
  const servers = lspServersForFile(ctx.config, absPath);
  if (servers.length === 0) return undefined;
  const live: LspClient[] = [];
  for (const server of servers) {
    const client = await startOrReuse(ctx, server);
    if (client.state === "connected") live.push(client);
  }
  return live;
}

async function startOrReuse(ctx: MuxContext, server: LspServerConfig): Promise<LspClient> {
  const key = clientKey(ctx.workspace, server.id);
  const existing = CLIENTS.get(key);
  if (existing !== undefined && existing.state === "connected") return existing;
  // A previously-unavailable or stopped client is replaced: a new call re-admits
  // the spawn (the guard decides again) rather than silently reusing a dead one.
  if (existing !== undefined && existing.state !== "connecting") {
    await existing.stop().catch(() => undefined);
    CLIENTS.delete(key);
  }
  const client = new LspClient({
    server,
    workspace: ctx.workspace,
    cwd: ctx.cwd,
    stateDir: kernelStateDir(ctx.workspace),
    hooks: ctx.hooks,
    connectTimeoutMs: ctx.connectTimeoutMs,
    requestTimeoutMs: ctx.requestTimeoutMs,
  });
  CLIENTS.set(key, client);
  await client.connect();
  return client;
}

/** Pids of the live LSP children (for the reaping test). */
export function lspPids(): number[] {
  const out: number[] = [];
  for (const client of CLIENTS.values()) {
    const pid = client.pid;
    if (pid !== undefined) out.push(pid);
  }
  return out;
}

/** Reap every client this process started and clear the registry. Idempotent. */
export async function shutdownAll(): Promise<void> {
  const clients = [...CLIENTS.values()];
  CLIENTS.clear();
  await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
}

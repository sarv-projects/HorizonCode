/**
 * workspace-diagnostics.ts — the reduced writethrough choreography.
 *
 * Given a file (abs path + current content), the LSP config, a DiagnosticsLedger
 * and the guard hooks, this syncs the content to every matching language server
 * and returns ONLY the fresh diagnostics (ledger-reduced) for the file:
 *
 *   1. select + start/reuse the matching servers (mux, guard + spawnOwned);
 *   2. for a CREATED path, if a server advertises the tsserver
 *      `typescript.tsserverRequest` executeCommand, force a
 *      `workspace/executeCommand reloadProjects` BEFORE the first didOpen so a
 *      stale missing-module resolution cannot be pinned. Feature-detected: a
 *      server that does not advertise it is a no-op (safe in this sandbox,
 *      where no real server runs);
 *   3. didOpen -> didChange(content) -> didSave, capturing the post-change
 *      document version;
 *   4. wait the bounded inline budget for a publish whose version EXACTLY
 *      matches that post-change version (freshness);
 *   5. format each diagnostic as `relPath:line:col severity message` so the
 *      ledger's location-prefix identity applies, MERGE across servers, and run
 *      the merged list through `ledger.reduce(absPath, messages)` — so a second
 *      pass over unchanged content de-charges and returns nothing new.
 *
 * REDUCTION stated honestly (v1): there is no deferred channel. If nothing
 * fresh arrives inside INLINE_DIAGNOSTICS_WAIT_MS this returns a `no issues`
 * result rather than blocking; late diagnostics are simply not surfaced this
 * turn. Capturing them out-of-band is out of scope for v1.
 */

import type { DiagnosticsLedger } from "../diagnostics-ledger";
import type { LspConfig } from "../config";
import { relPath } from "../../tools/helpers";
import { LspClient, pathToFileUri } from "./client";
import { clientsForFile, type MuxContext } from "./mux";
import { severityWord, type Diagnostic, type FileDiagnosticsResult } from "./types";

/** The tsserver reload barrier command (typescript-language-server specific). */
const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

/**
 * Bounded inline wait for a version-matching publish, per server. A real server
 * typically publishes within a few hundred ms of a save; 3 s is generous for a
 * warm server and still bounded so a cold/slow server never blocks the tool.
 */
export const INLINE_DIAGNOSTICS_WAIT_MS = 3_000;

export interface WorkspaceDiagnosticsInput {
  absPath: string;
  content: string;
  languageId?: string;
  /** True when this call follows a file CREATE (drives the tsserver reload barrier). */
  created?: boolean;
  config: LspConfig | undefined;
  ledger: DiagnosticsLedger;
  workspace: string;
  cwd: string;
  hooks: MuxContext["hooks"];
  signal?: AbortSignal;
  /** Override the per-server inline wait (tests use a short/long value). */
  waitMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Run the writethrough and return the fresh diagnostics for the file, or
 * `undefined` when no language server is configured for the file (the caller's
 * graceful no-op). Never throws for a server-level failure.
 */
export async function workspaceDiagnostics(input: WorkspaceDiagnosticsInput): Promise<FileDiagnosticsResult | undefined> {
  const muxCtx: MuxContext = {
    workspace: input.workspace,
    cwd: input.cwd,
    config: input.config,
    hooks: input.hooks,
    connectTimeoutMs: input.connectTimeoutMs,
    requestTimeoutMs: input.requestTimeoutMs,
  };

  let clients: LspClient[] | undefined;
  try {
    clients = await clientsForFile(muxCtx, input.absPath);
  } catch {
    // The mux never throws by contract; if it somehow does, degrade to no-op.
    clients = [];
  }
  if (clients === undefined) return undefined; // no configured server for this file

  const uri = pathToFileUri(input.absPath);
  const languageId = input.languageId ?? languageIdForPath(input.absPath);
  const waitMs = input.waitMs ?? INLINE_DIAGNOSTICS_WAIT_MS;
  const budget = Math.max(1, Math.floor(waitMs));

  const perServer = await Promise.all(
    clients.map(async (client) => {
      if (input.signal?.aborted) return { server: client.serverId, diagnostics: [] as Diagnostic[] };
      try {
        // (2) CREATED-path reload barrier, feature-detected and server-specific.
        if (input.created === true && client.supportsExecuteCommand(TSSERVER_REQUEST_COMMAND)) {
          try {
            await client.executeCommand(TSSERVER_REQUEST_COMMAND, [
              "reloadProjects",
              {},
              { executionTarget: 0, expectsResult: true, isAsync: false, lowPriority: false },
            ]);
          } catch {
            /* a failed reload barrier must not sink the diagnostics pass */
          }
        }
        // (3) sync: open (if new), change to the content, save.
        if (client.documentVersion(uri) === 0) client.didOpen(uri, languageId, input.content);
        const version = client.didChange(uri, input.content);
        client.didSave(uri, input.content);
        // (4) wait for the publish whose version matches exactly.
        const diagnostics = await client.waitForDiagnostics(uri, version, budget);
        return { server: client.serverId, diagnostics };
      } catch {
        return { server: client.serverId, diagnostics: [] as Diagnostic[] };
      }
    }),
  );

  // (5) format + merge across every server that synced.
  const rel = relPath(input.cwd, input.absPath);
  const merged: string[] = [];
  const serverIds: string[] = [];
  for (const entry of perServer) {
    serverIds.push(entry.server);
    for (const diagnostic of entry.diagnostics) {
      merged.push(formatDiagnostic(rel, diagnostic));
    }
  }

  // Ledger reduction: only fresh messages survive. An empty current set clears
  // the file's seen-set (a problem that vanished and returns is fresh again).
  const fresh = input.ledger.reduce(input.absPath, merged);
  const { summary, errored } = summarize(fresh);
  return {
    server: serverIds.length > 0 ? [...new Set(serverIds)].join("+") : "lsp",
    messages: fresh,
    summary,
    errored,
  };
}

/** `relPath:line:col severity message` — the ledger identity regex strips the prefix. */
function formatDiagnostic(rel: string, diagnostic: Diagnostic): string {
  const line = (diagnostic.range?.start?.line ?? 0) + 1;
  const col = (diagnostic.range?.start?.character ?? 0) + 1;
  const word = severityWord(diagnostic.severity);
  const code = diagnostic.code !== undefined ? ` [${diagnostic.code}]` : "";
  return `${rel}:${line}:${col} ${word} ${diagnostic.message}${code}`;
}

/** A compact human summary of the (fresh) messages. */
function summarize(messages: string[]): { summary: string; errored: boolean } {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const message of messages) {
    // The severity word sits right after the `file:line:col ` prefix.
    const match = /:\d+:\d+\s+(error|warning|info|hint)\b/.exec(message);
    if (match === null) continue;
    counts[match[1] as keyof typeof counts] += 1;
  }
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} error(s)`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
  if (counts.info > 0) parts.push(`${counts.info} info(s)`);
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
  return { summary: parts.length > 0 ? parts.join(", ") : "no issues", errored: counts.error > 0 };
}

/** A best-effort LSP languageId from the file extension. */
function languageIdForPath(absPath: string): string {
  const dot = absPath.lastIndexOf(".");
  const ext = dot >= 0 ? absPath.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    case "json":
      return "json";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    default:
      return ext === "" ? "plaintext" : ext;
  }
}

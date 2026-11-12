/**
 * types.ts — the minimal LSP surface this subsystem uses.
 *
 * A reduced slice of the Language Server Protocol: the JSON-RPC envelopes, the
 * diagnostics shapes we read off `textDocument/publishDiagnostics`, and the
 * result shape the writethrough hands back. Nothing here is `any`; a field the
 * reduced client never reads is simply absent rather than typed loosely.
 */

import type { LspServerConfig } from "../config";

/** A configured language server, aliased from the (FEAT-002) config shape. */
export type ServerConfig = LspServerConfig;

/* ------------------------------ JSON-RPC ------------------------------ */

/** A request carries an id and expects a matching response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** A notification carries no id and expects no response. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A response: `result` on success, `error` on failure, keyed by the request id. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/* ------------------------------ Diagnostics ------------------------------ */

/** A zero-based position inside a document. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** 1 error, 2 warning, 3 info, 4 hint (LSP DiagnosticSeverity). */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

/** The params of a `textDocument/publishDiagnostics` notification. */
export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
  /** The document version these diagnostics describe (freshness anchor). */
  version?: number | null;
}

/* --------------------------- Writethrough result --------------------------- */

/**
 * One server's diagnostics for one file, after formatting and ledger reduction.
 * `messages` are `relPath:line:col severity message` so the ledger's
 * location-prefix identity regex applies unchanged.
 */
export interface FileDiagnosticsResult {
  /** The server(s) that answered, joined with "+" when several merged. */
  server: string;
  /** Fresh diagnostics only (post-ledger), each a formatted line. */
  messages: string[];
  /** A short human summary (`2 error(s), 1 warning(s)` or `no issues`). */
  summary: string;
  /** True when at least one message is an error (severity 1). */
  errored: boolean;
}

/** Map an LSP severity to the word the formatted message carries. */
export function severityWord(severity: DiagnosticSeverity | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

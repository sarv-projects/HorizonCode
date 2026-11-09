/**
 * index.ts — the public surface of the LSP subsystem.
 *
 * The tool (tools/lsp.ts) and tests import from here: the spawn admission, the
 * client, the mux entry points, the writethrough entry, and the reduced types.
 */

export { encodeMessage, LspFramer } from "./framing";
export {
  LspClient,
  lspSpawnAction,
  pathToFileUri,
  LSP_CLIENT_NAME,
  LSP_CLIENT_VERSION,
  LSP_CONNECT_TIMEOUT_MS,
  LSP_REQUEST_TIMEOUT_MS,
  type LspClientOptions,
  type LspClientState,
  type LspGuardHooks,
  type LspUnavailableReason,
} from "./client";
export { clientsForFile, lspPids, shutdownAll, type MuxContext } from "./mux";
export {
  workspaceDiagnostics,
  INLINE_DIAGNOSTICS_WAIT_MS,
  type WorkspaceDiagnosticsInput,
} from "./workspace-diagnostics";
export {
  severityWord,
  type Diagnostic,
  type DiagnosticSeverity,
  type FileDiagnosticsResult,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Position,
  type PublishDiagnosticsParams,
  type Range,
  type ServerConfig,
} from "./types";

/**
 * fake-lsp-server.ts — a real child LSP server for the LSP client tests.
 *
 * Content-Length framed JSON-RPC 2.0 on stdio, exactly the wire shape the LSP
 * client speaks (core/lsp/framing.ts). Nothing is mocked: the tests assert what
 * this process actually wrote, what the guard was asked, and pid/ledger liveness.
 *
 * Behaviour:
 *  - `initialize` answers with capabilities advertising publishDiagnostics
 *    versionSupport and textDocument.save. When FAKE_LSP_EXECUTE_COMMAND is set
 *    it ALSO advertises `executeCommandProvider.commands` including
 *    `typescript.tsserverRequest`, so a test can exercise the reload-before-
 *    didOpen branch; `workspace/executeCommand` for that command answers
 *    `{ success: true }` and records that it ran.
 *  - `initialized`/`didOpen`/`didChange`/`didSave` are notifications; the server
 *    tracks the LATEST document version per uri (didOpen=1, each didChange is
 *    the client-sent version) and, on each sync, PUBLISHES
 *    `textDocument/publishDiagnostics` stamped with the CURRENT version and a
 *    DETERMINISTIC diagnostic derived from the synced content: one error when
 *    the content contains the sentinel `ERRORLINE`, none otherwise. That lets a
 *    test prove version-freshness and fresh-only de-charge.
 *
 * Control knobs (env, mirroring mcp-echo-server.ts's MCP_ECHO_DIE_FILE):
 *  - FAKE_LSP_DIE_ON_INIT=1        — exit(3) during `initialize` (handshake
 *                                    failure -> graceful degrade).
 *  - FAKE_LSP_PUBLISH_DELAY_MS=N   — delay each publish by N ms (a test sets it
 *                                    past the inline budget to prove the timeout
 *                                    path returns `no issues`).
 *  - FAKE_LSP_EXECUTE_COMMAND=1    — advertise the tsserver reload executeCommand.
 */

const DIE_ON_INIT = process.env.FAKE_LSP_DIE_ON_INIT === "1";
const PUBLISH_DELAY_MS = Number.parseInt(process.env.FAKE_LSP_PUBLISH_DELAY_MS ?? "0", 10) || 0;
const ADVERTISE_EXECUTE = process.env.FAKE_LSP_EXECUTE_COMMAND === "1";
const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";
const SENTINEL = "ERRORLINE";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The latest synced version and text per document uri. */
const docs = new Map<string, { version: number; text: string }>();
let reloadProjectsRuns = 0;

function write(message: Record<string, unknown>): void {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(header);
  process.stdout.write(body);
}

function reply(id: number, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function initializeResult(): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    publishDiagnostics: { versionSupport: true },
  };
  if (ADVERTISE_EXECUTE) {
    capabilities.executeCommandProvider = { commands: [TSSERVER_REQUEST_COMMAND] };
  }
  return { capabilities, serverInfo: { name: "fake-lsp", version: "0.0.1" } };
}

/** Publish diagnostics for a uri stamped with its current version. */
function publish(uri: string): void {
  const doc = docs.get(uri);
  if (doc === undefined) return;
  const diagnostics =
    doc.text.includes(SENTINEL)
      ? [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            severity: 1,
            code: "E-SENTINEL",
            source: "fake-lsp",
            message: `sentinel ${SENTINEL} present`,
          },
        ]
      : [];
  const send = (): void => write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version: doc.version, diagnostics } });
  if (PUBLISH_DELAY_MS > 0) setTimeout(send, PUBLISH_DELAY_MS);
  else send();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function handle(message: Record<string, unknown>): void {
  const method = typeof message.method === "string" ? message.method : "";
  const id = typeof message.id === "number" ? message.id : undefined;
  const params = asRecord(message.params);

  if (method === "initialize") {
    if (DIE_ON_INIT) process.exit(3);
    if (id !== undefined) reply(id, initializeResult());
    return;
  }
  if (method === "initialized") return;

  if (method === "textDocument/didOpen") {
    const td = asRecord(params.textDocument);
    const uri = typeof td.uri === "string" ? td.uri : "";
    const version = typeof td.version === "number" ? td.version : 1;
    const text = typeof td.text === "string" ? td.text : "";
    if (uri !== "") {
      docs.set(uri, { version, text });
      publish(uri);
    }
    return;
  }
  if (method === "textDocument/didChange") {
    const td = asRecord(params.textDocument);
    const uri = typeof td.uri === "string" ? td.uri : "";
    const version = typeof td.version === "number" ? td.version : (docs.get(uri)?.version ?? 1);
    const changes = Array.isArray(params.contentChanges) ? params.contentChanges : [];
    const last = asRecord(changes[changes.length - 1]);
    const text = typeof last.text === "string" ? last.text : (docs.get(uri)?.text ?? "");
    if (uri !== "") {
      docs.set(uri, { version, text });
      publish(uri);
    }
    return;
  }
  if (method === "textDocument/didSave") {
    const td = asRecord(params.textDocument);
    const uri = typeof td.uri === "string" ? td.uri : "";
    if (uri !== "" && docs.has(uri)) publish(uri);
    return;
  }

  if (method === "workspace/executeCommand") {
    const command = typeof params.command === "string" ? params.command : "";
    if (command === TSSERVER_REQUEST_COMMAND) reloadProjectsRuns += 1;
    if (id !== undefined) reply(id, { success: true, runs: reloadProjectsRuns });
    return;
  }

  if (method === "shutdown") {
    if (id !== undefined) reply(id, null);
    return;
  }

  // Any other request: answer method-not-found so the client never hangs.
  if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

/* ------------------------------ stdin framing ------------------------------ */

let buffer = new Uint8Array(0);
const HEADER_TERMINATOR = "\r\n\r\n";

function pushAndDrain(chunk: Uint8Array): void {
  const next = new Uint8Array(buffer.length + chunk.length);
  next.set(buffer, 0);
  next.set(chunk, buffer.length);
  buffer = next;
  for (;;) {
    const text = decoder.decode(buffer);
    const sep = text.indexOf(HEADER_TERMINATOR);
    if (sep < 0) break;
    const header = text.slice(0, sep);
    const headerBytes = encoder.encode(header).length + HEADER_TERMINATOR.length;
    let length = -1;
    for (const line of header.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
        length = Number.parseInt(line.slice(colon + 1).trim(), 10);
      }
    }
    if (!Number.isInteger(length) || length < 0) {
      buffer = buffer.slice(headerBytes);
      continue;
    }
    const frameEnd = headerBytes + length;
    if (buffer.length < frameEnd) break;
    const bodyBytes = buffer.slice(headerBytes, frameEnd);
    buffer = buffer.slice(frameEnd);
    try {
      const parsed: unknown = JSON.parse(decoder.decode(bodyBytes));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        handle(parsed as Record<string, unknown>);
      }
    } catch {
      /* not a frame: ignore */
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => pushAndDrain(new Uint8Array(chunk)));
process.stdin.resume();

/**
 * Shared fake DAP adapter logic (stdio + TCP fixtures, docs/33 §5.1).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_TERMINATOR = "\r\n\r\n";

export interface FakeDapConnection {
  push(chunk: Uint8Array): void;
}

export function createFakeDapConnection(write: (frame: Uint8Array) => void): FakeDapConnection {
  let seq = 1;
  let pendingLaunchSeq: number | undefined;
  let pendingAttachSeq: number | undefined;
  let configurationDone = false;
  let buffer = new Uint8Array(0);

  function writeMessage(message: Record<string, unknown>): void {
    const body = encoder.encode(JSON.stringify(message));
    const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    write(header);
    write(body);
  }

  function respond(requestSeq: number, body: Record<string, unknown>, command = ""): void {
    writeMessage({ type: "response", request_seq: requestSeq, success: true, command, body, seq: seq++ });
  }

  function completeStartIfReady(kind: "launch" | "attach"): void {
    const pending = kind === "launch" ? pendingLaunchSeq : pendingAttachSeq;
    if (pending === undefined || !configurationDone) return;
    if (kind === "launch") pendingLaunchSeq = undefined;
    else pendingAttachSeq = undefined;
    respond(pending, {}, kind);
    writeMessage({ type: "event", event: "stopped", body: { reason: "entry", threadId: 1 }, seq: seq++ });
  }

  function onFrame(json: Record<string, unknown>): void {
    if (json.type !== "request" || typeof json.seq !== "number") return;
    const cmd = String(json.command ?? "");
    const req = json.seq as number;
    const args = (json.arguments ?? {}) as Record<string, unknown>;

    if (cmd === "initialize") {
      respond(req, { supportsConfigurationDoneRequest: true }, "initialize");
      writeMessage({ type: "event", event: "initialized", body: {}, seq: seq++ });
      return;
    }
    if (cmd === "configurationDone") {
      configurationDone = true;
      respond(req, {}, "configurationDone");
      completeStartIfReady("launch");
      completeStartIfReady("attach");
      return;
    }
    if (cmd === "launch") {
      pendingLaunchSeq = req;
      completeStartIfReady("launch");
      return;
    }
    if (cmd === "attach") {
      pendingAttachSeq = req;
      completeStartIfReady("attach");
      return;
    }
    if (cmd === "disconnect") {
      respond(req, {}, "disconnect");
      return;
    }
    if (cmd === "threads") {
      respond(req, { threads: [{ id: 1, name: "main" }] }, "threads");
      return;
    }
    if (cmd === "stackTrace") {
      respond(
        req,
        {
          stackFrames: [{ id: 10, name: "main", line: 1, column: 1, source: { name: "app.ts", path: "/app.ts" } }],
          totalFrames: 1,
        },
        "stackTrace",
      );
      return;
    }
    if (cmd === "scopes") {
      respond(req, { scopes: [{ name: "Locals", variablesReference: 100, expensive: false }] }, "scopes");
      return;
    }
    if (cmd === "variables") {
      const ref = args.variablesReference;
      if (ref === 100) {
        respond(req, { variables: [{ name: "x", value: "42", type: "number", variablesReference: 0 }] }, "variables");
        return;
      }
      respond(req, { variables: [] }, "variables");
      return;
    }
    if (cmd === "setBreakpoints") {
      const bps = Array.isArray(args.breakpoints)
        ? (args.breakpoints as Array<{ line?: number }>).map((bp, i) => ({
            id: i + 1,
            verified: true,
            line: typeof bp.line === "number" ? bp.line : 1,
          }))
        : [];
      respond(req, { breakpoints: bps }, "setBreakpoints");
      return;
    }
    if (cmd === "continue" || cmd === "next" || cmd === "stepIn" || cmd === "stepOut") {
      respond(req, { allThreadsContinued: cmd === "continue" }, cmd);
      writeMessage({
        type: "event",
        event: "stopped",
        body: { reason: cmd === "continue" ? "breakpoint" : "step", threadId: 1 },
        seq: seq++,
      });
      return;
    }
    respond(req, {}, cmd);
  }

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
      if (!Number.isFinite(length) || length < 0 || buffer.length < headerBytes + length) break;
      const body = decoder.decode(buffer.slice(headerBytes, headerBytes + length));
      buffer = buffer.slice(headerBytes + length);
      try {
        onFrame(JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* */
      }
    }
  }

  return { push: pushAndDrain };
}

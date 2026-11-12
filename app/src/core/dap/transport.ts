/**
 * dap/transport.ts — TCP/socket connect helpers for DAP adapters (docs/33 §5.1).
 *
 * Stdio adapters talk DAP on the child pipes. Socket/tcp adapters (dlv, js-debug,
 * codelldb --port 0) print a listen address then accept a TCP client. This module
 * parses that announcement and opens a Bun TCP socket for DapClient.write/push.
 */

export interface DapTcpEndpoint {
  host: string;
  port: number;
}

/** Match common "listening at host:port" lines from dlv / js-debug / codelldb. */
const LISTEN_RE =
  /(?:(?:DAP|API)\s+server\s+)?listening\s+(?:at|on):?\s*(?:tcp:\/\/)?(?:\[)?([^\s\]:]+)(?:\])?:(\d+)/i;

export function parseDapListenLine(line: string): DapTcpEndpoint | null {
  const m = LISTEN_RE.exec(line);
  if (!m) return null;
  const host = m[1] === "*" || m[1] === "0.0.0.0" ? "127.0.0.1" : m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/** Scan accumulated stdout for a listen announcement. Returns null until found. */
export function findDapListenEndpoint(chunk: string): DapTcpEndpoint | null {
  for (const line of chunk.split(/\r?\n/)) {
    const hit = parseDapListenLine(line);
    if (hit) return hit;
  }
  return null;
}

export async function waitForDapListenEndpoint(
  readChunk: () => Promise<Uint8Array | null>,
  timeoutMs = 10_000,
): Promise<DapTcpEndpoint> {
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const chunk = await Promise.race([
      readChunk(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 250))),
    ]);
    if (chunk && chunk.length > 0) {
      buf += new TextDecoder().decode(chunk);
      const hit = findDapListenEndpoint(buf);
      if (hit) return hit;
    }
  }
  throw new Error(`DAP adapter did not announce a listen address within ${timeoutMs}ms`);
}

export interface DapTcpPipe {
  write: (frame: Uint8Array) => void;
  /** Deliver inbound bytes to `onData` until the socket closes or `signal` aborts. */
  pump: (onData: (chunk: Uint8Array) => void, signal?: AbortSignal) => Promise<void>;
  close: () => void;
}

/** Open a TCP connection to a DAP adapter listen endpoint. */
export async function connectDapTcp(endpoint: DapTcpEndpoint): Promise<DapTcpPipe> {
  let dataHandler: ((chunk: Uint8Array) => void) | undefined;
  const early: Uint8Array[] = [];
  let closeResolve: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  const socket = await Bun.connect({
    hostname: endpoint.host,
    port: endpoint.port,
    socket: {
      data(_s, data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (dataHandler) dataHandler(chunk);
        else early.push(chunk);
      },
      open() {},
      close() {
        closeResolve?.();
      },
      error() {
        closeResolve?.();
      },
    },
  });

  return {
    write(frame: Uint8Array) {
      socket.write(frame);
    },
    async pump(onData, signal) {
      dataHandler = onData;
      for (const pending of early.splice(0)) onData(pending);
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
          done();
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        void closed.then(done);
      });
    },
    close() {
      try {
        socket.end();
      } catch {
        /* ignore */
      }
    },
  };
}

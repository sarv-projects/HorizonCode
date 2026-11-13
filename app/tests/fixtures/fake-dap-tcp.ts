/**
 * In-process TCP fake DAP adapter (Content-Length framing, no dlv).
 */

import { createFakeDapConnection } from "./fake-dap-handler";

export interface FakeDapTcpServer {
  host: string;
  port: number;
  stop: () => void;
}

/** Start a localhost DAP adapter that speaks the same protocol as `fake-dap-server.ts`. */
export function startFakeDapTcpServer(): FakeDapTcpServer {
  const host = "127.0.0.1";
  const server = Bun.listen({
    hostname: host,
    port: 0,
    socket: {
      data(socket, data) {
        const conn = socket.data as ReturnType<typeof createFakeDapConnection> | undefined;
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        conn?.push(chunk);
      },
      open(socket) {
        socket.data = createFakeDapConnection((frame) => {
          socket.write(frame);
        });
      },
      close() {},
      error() {},
    },
  });
  return {
    host,
    port: server.port ?? 0,
    stop: () => server.stop(true),
  };
}

/**
 * Minimal HTTP CONNECT listener for wiring tests (not policy enforcement).
 *
 * Accepts CONNECT and responds 403; plain HTTP gets 501. No TLS, no decider.
 * For decider-backed denial tests use `egress-connect-proxy.ts` — that still
 * does not MITM shell traffic; `doctor` egress.shell remains honest.
 */

export type EgressConnectStub = {
  url: string;
  port: number;
  stop: () => void;
};

export function startEgressConnectStub(port = 0): Promise<EgressConnectStub> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        if (req.method === "CONNECT") {
          return new Response("CONNECT blocked (stub)\n", { status: 403 });
        }
        return new Response("egress connect stub: use CONNECT\n", { status: 501 });
      },
    });
    const listenPort = server.port;
    if (listenPort === undefined || listenPort <= 0) {
      server.stop();
      reject(new Error("egress connect stub: no listen port"));
      return;
    }
    resolve({
      url: `http://127.0.0.1:${listenPort}`,
      port: listenPort,
      stop: () => server.stop(),
    });
  });
}

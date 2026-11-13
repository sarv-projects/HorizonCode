import { describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import {
  egressTlsInterceptRefuseForward,
  mintHermeticLeafCert,
  writeHermeticInterceptCaMaterial,
} from "../../src/core/egress-tls-intercept-ca";
import { egressTlsTerminateAttempt, egressTlsTerminateUpstreamPipeEnabled } from "../../src/core/egress-tls-terminate";

function startHermeticTlsUpstream(
  caCertPath: string,
  caKeyPath: string,
): Promise<{ port: number; upstreamCaCertPath: string; stop: () => void }> {
  const leaf = mintHermeticLeafCert(caCertPath, caKeyPath, "localhost");
  const server = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (socket) => {
    socket.once("data", () => {
      const body = "hermetic-285-upstream";
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
      );
      socket.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, upstreamCaCertPath: caCertPath, stop: () => server.close() });
    });
  });
}

async function readUntilHeadersEnd(socket: net.Socket): Promise<void> {
  let buf = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes(Buffer.from("\r\n\r\n"))) {
        socket.off("data", onData);
        resolve();
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("egress TLS terminate precursor", () => {
  test("refuse forward disabled when terminate armed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-term-gate-"));
    const { caCertPath } = writeHermeticInterceptCaMaterial(dir);
    try {
      const env = {
        HZ_EGRESS_TLS_INTERCEPT: "1",
        HZ_EGRESS_TLS_INTERCEPT_CA: caCertPath,
        HZ_EGRESS_TLS_TERMINATE: "1",
      };
      expect(egressTlsInterceptRefuseForward(env)).toBe(false);
      expect(egressTlsTerminateAttempt(env)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONNECT terminate pipes TLS upstream request/response (hermetic)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-term-e2e-"));
    const { caCertPath, caKeyPath } = writeHermeticInterceptCaMaterial(dir);
    const upstream = await startHermeticTlsUpstream(caCertPath, caKeyPath);
    const caPem = readFileSync(caCertPath, "utf8");
    const env = {
      HZ_EGRESS_TLS_INTERCEPT: "1",
      HZ_EGRESS_TLS_INTERCEPT_CA: caCertPath,
      HZ_EGRESS_TLS_INTERCEPT_CA_KEY: caKeyPath,
      HZ_EGRESS_TLS_TERMINATE: "1",
      HZ_EGRESS_FORWARD: "1",
      HZ_EGRESS_TLS_UPSTREAM_CA: upstream.upstreamCaCertPath,
    };
    expect(egressTlsTerminateUpstreamPipeEnabled(env)).toBe(true);
    const authority = `localhost:${upstream.port}`;
    const proxy = await startEgressConnectProxy({
      forward: true,
      policy: [{ host: "localhost", decision: "allow" }],
      env,
    });
    try {
      const socket = net.connect(proxy.port, "127.0.0.1");
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      await readUntilHeadersEnd(socket);

      const tlsSocket = tls.connect({
        socket,
        servername: "localhost",
        ca: caPem,
        rejectUnauthorized: true,
      });
      await new Promise<void>((resolve, reject) => {
        tlsSocket.once("secureConnect", () => resolve());
        tlsSocket.once("error", reject);
      });

      const req = "GET /hermetic-285 HTTP/1.1\r\nHost: test.local\r\n\r\n";
      const body = await new Promise<string>((resolve, reject) => {
        tlsSocket.write(req);
        let acc = "";
        tlsSocket.on("data", (chunk) => {
          acc += chunk.toString("utf8");
          if (acc.includes("hermetic-285-upstream")) {
            resolve(acc);
          }
        });
        tlsSocket.once("error", reject);
      });
      expect(body).toContain("hermetic-285-upstream");
      expect(proxy.terminateObservations.some((o) => o.firstHttpLine?.includes("hermetic-285"))).toBe(true);
      tlsSocket.end();
    } finally {
      proxy.stop();
      upstream.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

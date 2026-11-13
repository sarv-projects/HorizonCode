import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { EGRESS_TLS_INTERCEPT_REFUSE_BODY, writeHermeticInterceptCaMaterial } from "../../src/core/egress-tls-intercept-ca";
import { tlsMitmPosture } from "../../src/core/egress-tls-mitm";
import { tlsClientHelloWithSni } from "../fixtures/tls-client-hello";

const FIXTURE_SNI = "tls-peek.hermetic.test";
const FAKE_TLS_CLIENT_HELLO = tlsClientHelloWithSni(FIXTURE_SNI);

function connectThroughConnectProxy(
  proxyPort: number,
  authority: string,
): Promise<{ socket: net.Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const statusLine = head.split("\r\n")[0] ?? "";
      if (!statusLine.includes(" 200 ")) {
        socket.destroy();
        reject(new Error(head));
        return;
      }
      resolve({ socket, head: head.split("\r\n\r\n")[1] ?? "" });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("egress TLS MITM honesty", () => {
  test("posture is unavailable without HZ_EGRESS_FORWARD", () => {
    const p = tlsMitmPosture({});
    expect(p.honesty).toBe("unavailable");
    expect(p.detail.toLowerCase()).toContain("never claim shell tls mitm enforced");
  });

  test("posture is advisory when forward is enabled", () => {
    const p = tlsMitmPosture({ HZ_EGRESS_FORWARD: "1" });
    expect(p.honesty).toBe("advisory");
    expect(p.detail.toLowerCase()).toContain("not terminated");
    expect(p.tlsPeek).toBe(false);
  });

  test("posture notes peek vs intercept when HZ_EGRESS_TLS_PEEK=1", () => {
    const p = tlsMitmPosture({ HZ_EGRESS_FORWARD: "1", HZ_EGRESS_TLS_PEEK: "1" });
    expect(p.tlsPeek).toBe(true);
    expect(p.tlsIntercept).toBe(false);
    expect(p.detail.toLowerCase()).toContain("peek");
    expect(p.detail.toLowerCase()).not.toContain("enforced");
  });

  test("posture notes intercept stub unavailable without CA", () => {
    const p = tlsMitmPosture({ HZ_EGRESS_FORWARD: "1", HZ_EGRESS_TLS_INTERCEPT: "1" });
    expect(p.tlsIntercept).toBe(true);
    expect(p.tlsInterceptCa).toBe(false);
    expect(p.detail.toLowerCase()).toMatch(/without ca|unavailable/);
    expect(p.detail).not.toContain("enforced");
  });

  test("CONNECT forward passes TLS bytes unchanged (hermetic)", async () => {
    const seen: Buffer[] = [];
    const upstream = net.createServer((s) => {
      s.on("data", (d) => {
        seen.push(Buffer.from(d));
        s.write(d);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = await startEgressConnectProxy({
      forward: true,
      policy: [{ host: "127.0.0.1", decision: "allow" }],
    });
    try {
      const { socket } = await connectThroughConnectProxy(proxy.port, `127.0.0.1:${upstreamPort}`);
      socket.write(FAKE_TLS_CLIENT_HELLO);
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        socket.once("data", (buf) => resolve(Buffer.from(buf)));
        socket.once("error", reject);
      });
      expect(Buffer.compare(echoed, FAKE_TLS_CLIENT_HELLO)).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(Buffer.compare(seen[0]!, FAKE_TLS_CLIENT_HELLO)).toBe(0);
      socket.destroy();
    } finally {
      proxy.stop();
      upstream.close();
    }
  });

  test("CONNECT forward with intercept+CA refuses fail-closed (hermetic)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-intercept-refuse-"));
  const { caCertPath } = writeHermeticInterceptCaMaterial(dir);
    try {
      const proxy = await startEgressConnectProxy({
        forward: true,
        policy: [{ host: "127.0.0.1", decision: "allow" }],
        env: {
          HZ_EGRESS_TLS_INTERCEPT: "1",
          HZ_EGRESS_TLS_INTERCEPT_CA: caCertPath,
        },
      });
      try {
        await expect(connectThroughConnectProxy(proxy.port, "127.0.0.1:9")).rejects.toThrow(EGRESS_TLS_INTERCEPT_REFUSE_BODY);
        expect(proxy.records.some((r) => r.status === 502)).toBe(true);
      } finally {
        proxy.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONNECT forward with tlsPeek records SNI without altering bytes", async () => {
    const seen: Buffer[] = [];
    const upstream = net.createServer((s) => {
      s.on("data", (d) => {
        seen.push(Buffer.from(d));
        s.write(d);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = await startEgressConnectProxy({
      forward: true,
      tlsPeek: true,
      policy: [{ host: "127.0.0.1", decision: "allow" }],
    });
    try {
      const { socket } = await connectThroughConnectProxy(proxy.port, `127.0.0.1:${upstreamPort}`);
      socket.write(FAKE_TLS_CLIENT_HELLO);
      await new Promise<void>((resolve) => {
        socket.once("data", () => resolve());
      });
      expect(proxy.sniPeeks.some((r) => r.sni === FIXTURE_SNI)).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(Buffer.compare(seen[0]!, FAKE_TLS_CLIENT_HELLO)).toBe(0);
      socket.destroy();
    } finally {
      proxy.stop();
      upstream.close();
    }
  });
});

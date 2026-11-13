import { describe, expect, test } from "bun:test";
import net from "node:net";
import { egressForwardEnabled, startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { startEgressConnectStub } from "../../src/core/egress-connect-stub";

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
      const rest = head.split("\r\n\r\n")[1] ?? "";
      resolve({ socket, head: rest });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("egress connect proxy", () => {
  test("stub refuses CONNECT (hermetic wiring)", async () => {
    const stub = await startEgressConnectStub(0);
    try {
      const res = await fetch(stub.url, { method: "CONNECT" });
      expect(res.status).toBe(403);
    } finally {
      stub.stop();
    }
  });

  test("proxy denies CONNECT to a policy-denied origin", async () => {
    const proxy = await startEgressConnectProxy({
      policy: [
        { host: "allowed.example", decision: "allow" },
        { host: "denied.example", decision: "deny" },
      ],
    });
    try {
      const denied = await fetch(proxy.url, { method: "CONNECT", headers: { host: "denied.example:443" } });
      expect(denied.status).toBe(403);
      const allowed = await fetch(proxy.url, { method: "CONNECT", headers: { host: "allowed.example:443" } });
      expect(allowed.status).toBe(502);
      expect(proxy.records.some((r) => r.authority === "denied.example:443" && r.status === 403)).toBe(true);
    } finally {
      proxy.stop();
    }
  });

  test("proxy without policy returns 503 — not shell-net enforced", async () => {
    const proxy = await startEgressConnectProxy({});
    try {
      const res = await fetch(proxy.url, { method: "CONNECT", headers: { host: "any.example:443" } });
      expect(res.status).toBe(503);
    } finally {
      proxy.stop();
    }
  });

  test("HZ_EGRESS_FORWARD=1 enables forward mode detection", () => {
    expect(egressForwardEnabled({ HZ_EGRESS_FORWARD: "1" })).toBe(true);
    expect(egressForwardEnabled({ HZ_EGRESS_FORWARD: "0" })).toBe(false);
  });

  test("forwards allowed CONNECT to a local TCP echo server (hermetic)", async () => {
    const echo = net.createServer((s) => {
      s.on("data", (d) => s.write(d));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const echoPort = (echo.address() as net.AddressInfo).port;

    const proxy = await startEgressConnectProxy({
      forward: true,
      policy: [{ host: "127.0.0.1", decision: "allow" }],
    });
    try {
      const { socket } = await connectThroughConnectProxy(proxy.port, `127.0.0.1:${echoPort}`);
      socket.write("ping");
      const echoed = await new Promise<string>((resolve, reject) => {
        socket.once("data", (buf) => resolve(buf.toString("utf8")));
        socket.once("error", reject);
      });
      expect(echoed).toBe("ping");
      expect(proxy.records.some((r) => r.authority === `127.0.0.1:${echoPort}` && r.status === 200)).toBe(true);
      socket.destroy();
    } finally {
      proxy.stop();
      echo.close();
    }
  });
});

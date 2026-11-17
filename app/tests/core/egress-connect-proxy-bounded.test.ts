/**
 * J-3 bounded CONNECT seam (hermetic): denied origin refused, allowed origin
 * tunneled to a fake TCP target, bounded connections + content-free audit rows,
 * clean shutdown. No TLS interception, no OS-enforcement claim.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  EGRESS_PROXY_ADVISORY_BANNER,
  resolveEgressProxyBind,
  startBoundedEgressConnectProxy,
  type BoundedEgressConnectProxy,
} from "../../src/core/egress-connect-proxy";
import type { EgressOriginRule } from "../../src/contracts";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

type FakeTarget = { port: number; received: string[]; sockets: Set<net.Socket>; stop: () => Promise<void> };

async function fakeTcpTarget(): Promise<FakeTarget> {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk.toString("utf8"));
      socket.write(chunk); // raw echo — the proxy must not inspect TLS bytes
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    received,
    sockets,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type ConnectReply = { socket: net.Socket; first: string };
function sendConnect(proxyPort: number, authority: string, timeoutMs = 3000): Promise<ConnectReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timed out"));
    }, timeoutMs);
    socket.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve({ socket, first: chunk.toString("latin1") });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function start(opts: Parameters<typeof startBoundedEgressConnectProxy>[0]): Promise<BoundedEgressConnectProxy> {
  return startBoundedEgressConnectProxy({ notice: false, ...opts });
}

describe("J-3 bounded egress CONNECT proxy", () => {
  test("bind opt-in: default off, HZ_EGRESS_PROXY_BIND=1 opts in on loopback", async () => {
    expect(resolveEgressProxyBind({}).enabled).toBe(false);
    expect(resolveEgressProxyBind({ HZ_EGRESS_PROXY_BIND: "0" }).enabled).toBe(false);
    expect(resolveEgressProxyBind({ HZ_EGRESS_PROXY_BIND: "1" })).toEqual({ enabled: true, host: "127.0.0.1" });
    await expect(start({ env: {} })).rejects.toThrow(/opt in/);
    expect(EGRESS_PROXY_ADVISORY_BANNER).toContain("ADVISORY");
  });

  test("denied origin is refused; no policy is fail-closed", async () => {
    const rules: EgressOriginRule[] = [{ host: "allowed.test", decision: "allow" }];
    const proxy = await start({ env: { HZ_EGRESS_PROXY_BIND: "1" }, policy: rules });
    const target = await fakeTcpTarget();
    try {
      const denied = await sendConnect(proxy.port, `127.0.0.1:${target.port}`);
      expect(denied.first.startsWith("HTTP/1.1 403")).toBe(true);
      denied.socket.destroy();
      expect(target.sockets.size).toBe(0);
      expect(proxy.records.some((r) => r.status === 403 && r.decision === "deny")).toBe(true);

      const noPolicy = await start({ env: { HZ_EGRESS_PROXY_BIND: "1" } });
      const refused = await sendConnect(noPolicy.port, `127.0.0.1:${target.port}`);
      expect(refused.first.startsWith("HTTP/1.1 503")).toBe(true);
      refused.socket.destroy();
      expect(noPolicy.records.some((r) => r.status === 503)).toBe(true);
      await noPolicy.stop();
    } finally {
      await proxy.stop();
      await target.stop();
    }
  });

  test("allowed origin tunnels raw bytes and shutdown is clean", async () => {
    const target = await fakeTcpTarget();
    const rules: EgressOriginRule[] = [{ host: "127.0.0.1", port: target.port, decision: "allow" }];
    const dir = tempDir("hz-egress-bounded-");
    const proxy = await start({
      env: { HZ_EGRESS_PROXY_BIND: "1" },
      policy: rules,
      stateDir: dir,
    });
    try {
      const reply = await sendConnect(proxy.port, `127.0.0.1:${target.port}`);
      expect(reply.first.startsWith("HTTP/1.1 200")).toBe(true);
      const echoed = new Promise<string>((resolve) => reply.socket.once("data", (c: Buffer) => resolve(c.toString("utf8"))));
      reply.socket.write("ping-through-tunnel");
      expect(await echoed).toBe("ping-through-tunnel");
      expect(target.received.join("")).toContain("ping-through-tunnel");
      expect(proxy.activeConnections()).toBeGreaterThanOrEqual(1);

      const audit = readFileSync(path.join(dir, "egress-proxy.ndjson"), "utf8");
      const rows = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows.some((r) => r.event === "banner")).toBe(true);
      const req = rows.find((r) => r.event === "connect.request");
      expect(req?.status).toBe(200);
      expect(req?.authority).toBe(`127.0.0.1:${target.port}`);
      expect(JSON.stringify(rows)).not.toMatch(/"(path|headers|body|query)"\s*:/);
    } finally {
      await proxy.stop();
    }
    // Listener is gone: a fresh connect is refused, and the target saw the close.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(target.sockets.size).toBe(0);
    await target.stop();
  });

  test("concurrent tunnels are bounded (503 at the cap)", async () => {
    const target = await fakeTcpTarget();
    const rules: EgressOriginRule[] = [{ host: "127.0.0.1", port: target.port, decision: "allow" }];
    const proxy = await start({
      env: { HZ_EGRESS_PROXY_BIND: "1" },
      policy: rules,
      maxConnections: 1,
    });
    try {
      const first = await sendConnect(proxy.port, `127.0.0.1:${target.port}`);
      expect(first.first.startsWith("HTTP/1.1 200")).toBe(true);
      const second = await sendConnect(proxy.port, `127.0.0.1:${target.port}`);
      expect(second.first.startsWith("HTTP/1.1 503")).toBe(true);
      second.socket.destroy();
      first.socket.destroy();
    } finally {
      await proxy.stop();
      await target.stop();
    }
  });
});

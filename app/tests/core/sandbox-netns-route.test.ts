import { describe, expect, test } from "bun:test";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import {
  mergeSandboxNetnsHonestySpawnEnv,
  netnsEgressRoutePosture,
  netnsIsolationExpected,
} from "../../src/core/sandbox-netns-route";
import { runDoctor, type DoctorEnv } from "../../src/core/doctor";

function doctorFakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    home: "/tmp",
    workspace: "/tmp/ws",
    env: { ...(over.env ?? process.env) },
    ...over,
  };
}

function doctorById(checks: ReturnType<typeof runDoctor>, id: string) {
  const line = checks.find((c) => c.id === id);
  if (line === undefined) throw new Error(`missing doctor line ${id}`);
  return line;
}

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

describe("netns egress route posture (ruling 288)", () => {
  test("HZ_SANDBOX_NETNS=1 maps to child net off on spawn env", () => {
    const merged = mergeSandboxNetnsHonestySpawnEnv({ HZ_SANDBOX_NETNS: "1" });
    expect(merged.HZ_SANDBOX_CHILD_NET).toBe("off");
  });

  test("route kinds distinguish ambient vs proxy partial", () => {
    const bin = resolveSandboxExecBinary(process.env);
    const base: Record<string, string | undefined> = { HZ_SANDBOX_EXEC: "1" };
    if (bin !== undefined) base.HZ_SANDBOX_EXEC_BIN = bin;
    const ambient = netnsEgressRoutePosture({ ...base, HZ_SANDBOX_CHILD_NET: "on" });
    expect(ambient.route).toBe("ambient");
    if (bin === undefined) return;
    const deny = netnsEgressRoutePosture({ ...base, HZ_SANDBOX_NETNS: "1" });
    expect(deny.route).toBe("deny-only");
    const partial = netnsEgressRoutePosture({
      ...base,
      HZ_SANDBOX_NETNS: "1",
      HZ_EGRESS_PROXY: "http://127.0.0.1:9",
    });
    expect(partial.route).toBe("proxy-env-partial");
    expect(partial.detail.toLowerCase()).toContain("never claim shell-net enforced");
  });

  test("doctor egress.netns.route line is warn and never enforced", () => {
    const line = doctorById(
      runDoctor(
        doctorFakeEnv({
          env: {
            ...doctorFakeEnv().env,
            HZ_SANDBOX_NETNS: "1",
            HZ_EGRESS_PROXY: "http://127.0.0.1:9",
          },
        }),
      ),
      "egress.netns.route",
    );
    expect(line.status).toBe("warn");
    expect(line.detail.toLowerCase()).toContain("proxy-routed partial");
    expect(line.detail.toLowerCase()).toContain("never claim shell-net enforced");
  });

  test("hermetic: direct 443 blocked in netns; CONNECT via proxy works outside netns", async () => {
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;
    expect(netnsIsolationExpected({ HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_EXEC_BIN: bin })).toBe(true);

    const directProbe = `
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("93.184.216.34", 443))
    print("CONNECTED")
except OSError as e:
    print("BLOCKED", getattr(e, "errno", e))
`;
    const blocked = spawnSync(bin, ["--", "python3", "-c", directProbe], {
      encoding: "utf8",
      env: { ...process.env, HZ_SANDBOX_CHILD_NET: "off" },
    });
    expect(blocked.stdout).toContain("BLOCKED");
    expect(blocked.stdout).not.toContain("CONNECTED");

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
      const proxyProbe = `
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("127.0.0.1", ${proxy.port}))
    print("PROXY_REACHABLE")
except OSError:
    print("PROXY_BLOCKED")
`;
      const inNetns = spawnSync(bin, ["--", "python3", "-c", proxyProbe], {
        encoding: "utf8",
        env: {
          ...process.env,
          HZ_SANDBOX_CHILD_NET: "off",
          HTTP_PROXY: proxy.url,
          HZ_EGRESS_PROXY: proxy.url,
        },
      });
      expect(inNetns.stdout).toContain("PROXY_BLOCKED");

      const { socket } = await connectThroughConnectProxy(proxy.port, `127.0.0.1:${echoPort}`);
      socket.write("via-proxy");
      const echoed = await new Promise<string>((resolve, reject) => {
        socket.once("data", (buf) => resolve(buf.toString("utf8")));
        socket.once("error", reject);
      });
      expect(echoed).toBe("via-proxy");
      expect(proxy.records.some((r) => r.status === 200)).toBe(true);
      socket.destroy();
    } finally {
      proxy.stop();
      echo.close();
    }
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import * as path from "node:path";
import {
  isSensitiveWriteTarget,
  protectedPathRefusal,
  shellCommandReferencesKernelState,
} from "../../src/core/kernel";
import { loadUserEnvFile, parseIcaclsUnsafePrincipals } from "../../src/core/config";
import { startBoundedEgressConnectProxy, startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { enforceConnectionClose } from "../../src/core/egress-tls-terminate";
import { mintHermeticLeafCert, writeHermeticInterceptCaMaterial } from "../../src/core/egress-tls-intercept-ca";
import { CredentialBroker } from "../../src/core/egress-credential-broker";
import { createEffectId, createScopedEffectHost, EffectHost } from "../../src/core/effect-host";
import { createWsFallbackLatch, recordWsRouteOutcome, shouldAttemptWsRoute } from "../../src/core/providers";
import { compactHistory } from "../../src/core/compaction";
import {
  discardStaged,
  setStructuredPlan,
  structuredPlanStepContext,
  structuredPlanSubtasks,
  structuredPlanSummary,
} from "../../src/core/plan";
import { SessionStore } from "../../src/core/session";
import { appendSessionEvent } from "../../src/core/session-event-store";
import { DeliveryLifecycle, AgentId, AttemptId, OpaqueAddress } from "../../src/core/subagent";
import type { ChatMsg } from "../../src/contracts";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

const hasOpenSsl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Track 2 P1-2 & P2: LocalKernel isSensitiveWriteTarget sync with guard.rs", () => {
  test("flags all execution-bearing workspace paths synced from guard.rs", () => {
    const ws = tempDir("hz-sensitive-sync-");
    const sensitive = [
      ".husky/pre-commit",
      ".husky/commit-msg",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".gitmodules",
      "Cargo.toml",
      "kernel/Cargo.toml",
      "build.rs",
      "pyproject.toml",
      "Dockerfile.prod",
      "Dockerfile.dev",
      "docker-compose.yml",
      "docker-compose.yaml",
      ".vscode/tasks.json",
      ".gitconfig",
    ];
    for (const rel of sensitive) {
      expect(isSensitiveWriteTarget(path.join(ws, rel)), `expected sensitive: ${rel}`).toBe(true);
    }
    expect(isSensitiveWriteTarget(path.join(ws, "src/index.ts"))).toBe(false);
    expect(isSensitiveWriteTarget(path.join(ws, ".vscode/settings.json"))).toBe(false);
  });
});

describe("Track 2 P1-3: kernel-state-protected Windows case-insensitivity, drive paths, quotes & globs", () => {
  test("case-insensitive fs.write and shell.exec on win32 with C:\\ and C:/ drive paths", () => {
    const stateDir = "C:\\Users\\Dev\\Repo\\.hz\\state\\kernel";
    expect(
      protectedPathRefusal(
        { kind: "fs.write", target: "c:\\users\\dev\\repo\\.HZ\\State\\Kernel\\policy.json" },
        stateDir,
        "win32",
      ),
    ).toContain("kernel-state-protected");
    expect(
      protectedPathRefusal(
        { kind: "fs.write", target: "C:/Users/Dev/Repo/.hz/STATE/KERNEL/leases.json" },
        stateDir,
        "win32",
      ),
    ).toContain("kernel-state-protected");
    expect(
      shellCommandReferencesKernelState("type C:\\Users\\Dev\\Repo\\.HZ\\State\\Kernel\\policy.json", stateDir, "win32"),
    ).toBe(true);
    expect(
      shellCommandReferencesKernelState("cat c:/users/dev/repo/.hz/state/kernel/policy.json", stateDir, "win32"),
    ).toBe(true);
  });

  test("detects quoted and globbed .hz/state/kernel references in shell commands", () => {
    const ws = tempDir("hz-kstate-glob-");
    const stateDir = path.join(ws, ".hz", "state", "kernel");
    expect(shellCommandReferencesKernelState('cat ".hz/state/kernel/policy.json"', stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState('cat .hz/"state"/kernel/policy.json', stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState("cat .hz/state/k*/policy.json", stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState("cat .hz/*/kernel/policy.json", stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState("cat .hz/st?te/[k]ernel/policy.json", stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState("cat .hzcode/k*/policy.json", stateDir)).toBe(true);
    expect(shellCommandReferencesKernelState("cat src/index.ts", stateDir)).toBe(false);
    expect(shellCommandReferencesKernelState("cat .hz/MEMORY.md", stateDir)).toBe(false);
  });
});

describe("Track 2 P1-5: egress proxy refuseNonPublic default & TLS terminate header buffering + Connection: close", () => {
  test("startBoundedEgressConnectProxy refuses non-public IPs by default when resolve is supplied", async () => {
    const target = net.createServer((s) => s.end("ok"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as net.AddressInfo).port;

    const sendConnect = (proxyPort: number, authority: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const sock = net.connect(proxyPort, "127.0.0.1", () => {
          sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        });
        sock.once("data", (chunk) => {
          sock.destroy();
          resolve(chunk.toString("latin1"));
        });
        sock.once("error", reject);
      });

    const strictProxy = await startBoundedEgressConnectProxy({
      notice: false,
      env: { HZ_EGRESS_PROXY_BIND: "1" },
      policy: [{ host: "internal.test", port, decision: "allow" }],
      resolve: async () => ["127.0.0.1"],
    });
    const loopbackProxy = await startBoundedEgressConnectProxy({
      notice: false,
      env: { HZ_EGRESS_PROXY_BIND: "1" },
      policy: [{ host: "internal.test", port, decision: "allow" }],
      resolve: async () => ["127.0.0.1"],
      refuseNonPublic: false,
    });
    try {
      const strictReply = await sendConnect(strictProxy.port, `internal.test:${port}`);
      expect(strictReply.startsWith("HTTP/1.1 502")).toBe(true);

      const loopbackReply = await sendConnect(loopbackProxy.port, `internal.test:${port}`);
      expect(loopbackReply.startsWith("HTTP/1.1 200")).toBe(true);
    } finally {
      await strictProxy.stop();
      await loopbackProxy.stop();
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  test("enforceConnectionClose replaces keep-alive with Connection: close", () => {
    const raw = "GET /api HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\n\r\nbody";
    const rewritten = enforceConnectionClose(raw);
    expect(rewritten).not.toContain("keep-alive");
    expect(rewritten).toContain("Connection: close\r\n\r\nbody");
  });

  test.skipIf(!hasOpenSsl)("TLS terminate buffers split HTTP headers until \\r\\n\\r\\n and injects Connection: close", async () => {
    const dir = tempDir("hz-tls-split-");
    const { caCertPath, caKeyPath } = writeHermeticInterceptCaMaterial(dir);
    const leaf = mintHermeticLeafCert(caCertPath, caKeyPath, "localhost");

    let received = "";
    const server = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (socket) => {
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n")) {
          const body = "ok-split";
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
          socket.end();
        }
      });
    });
    const upstreamPort = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });

    const env = {
      HZ_EGRESS_TLS_INTERCEPT: "1",
      HZ_EGRESS_TLS_INTERCEPT_CA: caCertPath,
      HZ_EGRESS_TLS_INTERCEPT_CA_KEY: caKeyPath,
      HZ_EGRESS_TLS_TERMINATE: "1",
      HZ_EGRESS_FORWARD: "1",
      HZ_EGRESS_TLS_UPSTREAM_CA: caCertPath,
    };
    const broker = new CredentialBroker([{ id: "tok", header: "authorization", value: "Bearer split-secret" }]);
    const proxy = await startEgressConnectProxy({
      forward: true,
      policy: [{ host: "localhost", decision: "allow" }],
      env,
      credentialInjection: {
        broker,
        rules: [{ host: "localhost", header: "authorization", secretId: "tok" }],
      },
    });
    try {
      const authority = `localhost:${upstreamPort}`;
      const sock = net.connect(proxy.port, "127.0.0.1");
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      await new Promise<void>((resolve, reject) => {
        let acc = "";
        const onData = (c: Buffer) => {
          acc += c.toString("latin1");
          if (acc.includes("\r\n\r\n")) {
            sock.off("data", onData);
            resolve();
          }
        };
        sock.on("data", onData);
        sock.once("error", reject);
      });

      const tlsSock = tls.connect({
        socket: sock,
        servername: "localhost",
        ca: readFileSync(caCertPath, "utf8"),
        rejectUnauthorized: false,
      });
      await new Promise<void>((resolve, reject) => {
        tlsSock.once("secureConnect", () => resolve());
        tlsSock.once("error", reject);
      });

      const done = new Promise<string>((resolve, reject) => {
        let acc = "";
        tlsSock.on("data", (c) => {
          acc += c.toString("utf8");
          if (acc.includes("ok-split")) resolve(acc);
        });
        tlsSock.once("error", reject);
      });
      tlsSock.write("GET /split HTTP/1.1\r\n");
      await new Promise((r) => setTimeout(r, 25));
      tlsSock.write("Host: localhost\r\nConnection: keep-alive\r\n\r\n");
      await done;

      expect(received).toContain("authorization: Bearer split-secret");
      expect(received).toContain("Connection: close");
      expect(received).not.toContain("Connection: keep-alive");
      tlsSock.end();
    } finally {
      proxy.stop();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Track 2 P1-6: loadUserEnvFile explicit Windows ACL check", () => {
  test("parseIcaclsUnsafePrincipals flags broad principals and ignores owner/SYSTEM/DENY", () => {
    const unsafeOutput = [
      "C:\\Users\\Dev\\.config\\horizon\\env NT AUTHORITY\\SYSTEM:(I)(F)",
      "                                      DESKTOP\\Dev:(I)(F)",
      "                                      BUILTIN\\Users:(I)(RX)",
      "                                      Everyone:(R)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcaclsUnsafePrincipals(unsafeOutput)).toEqual(["BUILTIN\\Users", "Everyone"]);

    const safeOutput = [
      "C:\\Users\\Dev\\.config\\horizon\\env NT AUTHORITY\\SYSTEM:(F)",
      "                                      DESKTOP\\Dev:(F)",
      "                                      Everyone:(DENY)(R)",
    ].join("\r\n");
    expect(parseIcaclsUnsafePrincipals(safeOutput)).toEqual([]);
  });

  test("loadUserEnvFile on win32 refuses broad ACLs and icacls failures, allows owner-only ACL", () => {
    const dir = tempDir("hz-win-env-");
    const envFile = path.join(dir, "env");
    writeFileSync(envFile, "HZ_MODEL=win-model\n", "utf8");
    chmodSync(envFile, 0o600);

    const broad = loadUserEnvFile({
      configDir: dir,
      platform: "win32",
      target: {},
      icaclsRunner: () => `${envFile} Everyone:(R)\r\n`,
    });
    expect(broad.skipped).toContain("Windows ACL grants access to broad principal");
    expect(broad.loaded).toEqual([]);

    const failed = loadUserEnvFile({
      configDir: dir,
      platform: "win32",
      target: {},
      icaclsRunner: () => {
        throw new Error("icacls failed");
      },
    });
    expect(failed.skipped).toContain("cannot verify Windows ACL");
    expect(failed.loaded).toEqual([]);

    const target: Record<string, string | undefined> = {};
    const safe = loadUserEnvFile({
      configDir: dir,
      platform: "win32",
      target,
      icaclsRunner: () => `${envFile} DESKTOP\\Dev:(F)\r\n`,
    });
    expect(safe.skipped).toBeUndefined();
    expect(safe.loaded).toEqual(["HZ_MODEL"]);
    expect(target.HZ_MODEL).toBe("win-model");
  });
});

describe("Track 2 P2: concurrent scoped childEffectIds", () => {
  test("two concurrent scoped hosts sharing one parent EffectHost do not cross-contaminate", async () => {
    const parent = new EffectHost();
    const childAIds: string[] = [];
    const childBIds: string[] = [];
    const scopedA = createScopedEffectHost(parent, childAIds);
    const scopedB = createScopedEffectHost(parent, childBIds);

    expect(scopedA instanceof EffectHost).toBe(true);

    const a1 = createEffectId();
    const a2 = createEffectId();
    const b1 = createEffectId();

    await Promise.all([
      (async () => {
        scopedA.begin(a1, "read", "ca-1");
        await new Promise((r) => setTimeout(r, 10));
        scopedA.begin(a2, "grep", "ca-2");
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        scopedB.begin(b1, "glob", "cb-1");
      })(),
    ]);

    expect(childAIds).toEqual([a1, a2]);
    expect(childBIds).toEqual([b1]);
    expect(parent.listEffectIds().sort()).toEqual([a1, a2, b1].sort());
  });
});

describe("Track 2 P2: wired modules integration", () => {
  test("providers/index.ts wires ws-fallback-latch", () => {
    const latch = createWsFallbackLatch({ threshold: 2, cooldownMs: 1000, now: () => 100 });
    expect(shouldAttemptWsRoute("route-1", latch)).toBe(true);
    recordWsRouteOutcome("route-1", false, "close-1006", latch);
    recordWsRouteOutcome("route-1", false, "close-1006", latch);
    expect(shouldAttemptWsRoute("route-1", latch)).toBe(false);
    recordWsRouteOutcome("route-1", true, undefined, latch);
    expect(shouldAttemptWsRoute("route-1", latch)).toBe(true);
  });

  test("compaction.ts wires compaction-generation and compaction-transcript-ladder", () => {
    const msgs: ChatMsg[] = [
      { role: "user", content: "Must keep tests green." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "Step 2" },
      { role: "assistant", content: "Done 2" },
    ];
    const gen1 = compactHistory(msgs, { limit: 2, sessionId: "sess-1" });
    expect(gen1.compacted).toBe(true);
    expect(gen1.generation?.generation).toBe(1);
    expect(gen1.generation?.sessionId).toBe("sess-1");

    const ladder = compactHistory(msgs, { limit: 2, sessionId: "sess-1", previousGeneration: gen1.generation, rungIndex: 3 });
    expect(ladder.rung).toBe("user_only");
    expect(ladder.generation?.generation).toBe(2);
    expect(ladder.history.every((m) => m.role === "user")).toBe(true);
  });

  test("plan.ts wires structured-plan subtasks and step-scoped context", () => {
    const reply = "### Tasks\n1. Update guard\n- tighten sed\nUses: app/src/core/command-guard.ts\n";
    const subtasks = setStructuredPlan("plan-sess", reply);
    expect(subtasks.length).toBe(1);
    expect(structuredPlanSubtasks("plan-sess").length).toBe(1);
    expect(structuredPlanSummary("plan-sess")).toContain("Update guard");
    const ctx = structuredPlanStepContext(
      "plan-sess",
      0,
      new Map([["app/src/core/command-guard.ts", "// guard"]]),
    );
    expect(ctx).toContain("// guard");
    discardStaged("plan-sess");
    expect(structuredPlanSubtasks("plan-sess")).toEqual([]);
  });

  test("session.ts wires session-projection lifecycle folding", () => {
    const dir = tempDir("hz-proj-wire-");
    const store = new SessionStore(dir);
    try {
      const s = store.createSession("Proj test");
      appendSessionEvent(store.db, { aggregateId: s.id, actorKind: "system", actorId: "system", type: "session.start", payload: { at: "2026-01-01T00:00:00Z" } });
      appendSessionEvent(store.db, { aggregateId: s.id, actorKind: "system", actorId: "system", type: "session.end", payload: { at: "2026-01-01T00:10:00Z" } });
      const folded = store.foldLifecycleEvents(s.id);
      expect(folded.applied).toBe(2);
      const view = store.lifecycleView(s.id);
      expect(view.startedAt).toBe("2026-01-01T00:00:00Z");
      expect(view.endedAt).toBe("2026-01-01T00:10:00Z");
      expect(view.eventCount).toBe(2);
    } finally {
      store.close();
    }
  });

  test("subagent.ts exports subagent-delivery tokens and lifecycle", () => {
    expect(AgentId.mint("abc").asStr()).toBe("ag1.abc");
    expect(AttemptId.mint("def").asStr()).toBe("at1.def");
    expect(OpaqueAddress.mint("ghi").asStr()).toBe("dx1.ghi");
    const lc = new DeliveryLifecycle<string>();
    lc.admitPending("k1", "payload");
    lc.beginProjection("k1");
    lc.commitAndDeliver("k1");
    expect(lc.phaseOf("k1")).toBe("delivered");
  });
});

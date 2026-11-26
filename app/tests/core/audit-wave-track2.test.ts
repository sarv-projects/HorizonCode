import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { deriveShellPermissionPatterns } from "../../src/core/shell-parse";
import { psRawWordHasDynamicExpansion, scanPowerShellCommand, scanShellCommand } from "../../src/core/shell-scan";
import { analyzeShellCompound } from "../../src/core/shell-split";
import { findPlanModeMutatingCommand } from "../../src/core/command-guard";
import { isNonPublicIp, parseIpLiteral } from "../../src/core/egress-ip-classify";
import { mintHermeticLeafCert } from "../../src/core/egress-tls-intercept-ca";
import { decideConnectAuthority, decideOrigin, normalizeNetworkRuleHost, originFromConnectAuthority, parseEgressPolicyDoc, parseOrigin } from "../../src/core/egress-decider";
import { ProxyTokenManager } from "../../src/core/egress-proxy-token";
import { CredentialBroker } from "../../src/core/egress-credential-broker";
import { injectCredentialHeaders } from "../../src/core/http-credential-inject";
import { deleteFileInSandbox } from "../../src/core/effect-host-atomic-delete";
import { renameFileInSandbox } from "../../src/core/effect-host-atomic-rename";
import { Op, runBytecode } from "../../src/core/code-mode-vm";
import { refreshOAuthAccessToken } from "../../src/core/auth/refresh";
import { writeOAuthToken } from "../../src/core/auth/store";
import { decodeCatalog, MINIMUM_PROVIDERS, writeCatalogCache } from "../../src/core/catalog/catalog";
import { refreshModelsCatalog } from "../../src/core/catalog/catalog-poll";
import { deterministicClassifier } from "../../src/core/guardian";
import { isSystemBoundaryPath } from "../../src/core/autonomy-envelope";
import { listSkills } from "../../src/core/skills";
import { loadPresets } from "../../src/core/agent-profiles";
import { verifyFdInWorkspace } from "../../src/core/sandbox-fd-verify";
import { execCreateVethInterfaceNames } from "../../src/core/sandbox-netns-spawn-wrapped-exec-create-connect";
import { ownerDeathSupervisorScript } from "../../src/core/supervisor";

const temps: string[] = [];
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup on win32 */
    }
  }
});

describe("Track 2 P0 — Shell AST & Command Guard", () => {
  test("shell-parse: unsafe envAssignments and declarations are opaque (never derive wildcard patterns)", () => {
    const preload = deriveShellPermissionPatterns("LD_PRELOAD=/tmp/evil.so git status");
    expect(preload.ok).toBe(false);
    expect(preload.opaque).toBe(true);
    expect(preload.patterns).toEqual([]);

    for (const decl of ["export PATH=/tmp/evil", "declare -x FOO=1", "typeset X=1"]) {
      const res = deriveShellPermissionPatterns(decl);
      expect(res.ok, decl).toBe(false);
      expect(res.opaque, decl).toBe(true);
      expect(res.patterns, decl).toEqual([]);
    }

    const safe = deriveShellPermissionPatterns("LC_ALL=C LANG=en_US.UTF-8 TZ=UTC NO_COLOR=1 git status");
    expect(safe.ok).toBe(true);
    expect(safe.opaque).toBe(false);
    expect(safe.patterns).toEqual(["git status *"]);
  });

  test("shell-scan: precommand wrapper flag arity and env -S unconditionally opaque", () => {
    for (const cmd of [
      'sudo -u root eval "id"',
      'sudo -g wheel -C 3 -h host source ./x.sh',
      'timeout -k 5 -s KILL 10 eval "id"',
      'stdbuf -i 0 -o L -e 0 eval "id"',
      'env -u FOO -C /tmp eval "id"',
      'env -S "sh -c id"',
      "env --split-string='ls'",
    ]) {
      const res = scanShellCommand(cmd);
      expect(res.opaque, cmd).toBe(true);
    }
  });

  test("shell-scan: PowerShell member/method/index expressions, module\\cmdlet prefixes, expanded opaque list, and backtick escaping", () => {
    for (const cmd of [
      '$ExecutionContext.InvokeCommand.InvokeScript("calc")',
      "$sb.Invoke()",
      "$arr[0]",
      'Microsoft.PowerShell.Utility\\Invoke-Expression "ls"',
      "Invoke-Command -ScriptBlock { ls }",
      "icm { ls }",
      "Start-Process calc",
      "saps calc",
      '& "\\$cmd"',
    ]) {
      const res = scanPowerShellCommand(cmd);
      expect(res.opaque, cmd).toBe(true);
    }
    expect(psRawWordHasDynamicExpansion('"\\$cmd"')).toBe(true);
    expect(psRawWordHasDynamicExpansion('"`$literal"')).toBe(false);
    expect(psRawWordHasDynamicExpansion("'$literal'")).toBe(false);
  });

  test("shell-split: fails closed on unquoted newline, single &, |&, {, }, <<<", () => {
    for (const cmd of [
      "ls\nrm -rf /",
      "ls & rm -rf /",
      "cmd1 |& cmd2",
      "{ ls; rm -rf /; }",
      "cat <<< secret",
    ]) {
      expect(analyzeShellCompound(cmd).ok, cmd).toBe(false);
    }
    expect(analyzeShellCompound("awk '{print $1}' file.ts").ok).toBe(true);
    expect(analyzeShellCompound("cat f 2>&1").ok).toBe(true);
  });

  test("command-guard: tracks backslash escapes outside quotes, blocks dangerous env vars, /var/tmp, and awk |&", () => {
    expect(findPlanModeMutatingCommand('echo \\"hello > pwn.txt')).toContain("redirect");
    expect(findPlanModeMutatingCommand("env LD_PRELOAD=/tmp/x.so ls")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("LD_PRELOAD=/tmp/x.so ls")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("env GIT_EXTERNAL_DIFF=sh git diff")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("env NODE_OPTIONS=--require=/tmp/x.js ls")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("env BASH_ENV=/tmp/x ls")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("env GIT_CONFIG_COUNT=1 git status")).toContain("dangerous env");
    expect(findPlanModeMutatingCommand("echo x > /var/tmp/out.txt")).toContain("redirect");
    expect(findPlanModeMutatingCommand('awk \'BEGIN{"id" |& getline}\'')).toContain("awk");
    expect(findPlanModeMutatingCommand('awk \'BEGIN{print "x" |& "sh"}\'')).toContain("awk");
  });
});

describe("Track 2 P0 — Egress, Atomic FS & Code-Mode VM", () => {
  test("egress-ip-classify: strict 32-bit IPv4 and 128-bit BigInt IPv6 classification", () => {
    // Reject leading-zero octal-style IPv4
    expect(parseIpLiteral("0177.0.0.1")).toBeUndefined();
    expect(isNonPublicIp("0177.0.0.1")).toBe(true);
    expect(parseIpLiteral("010.0.0.1")).toBeUndefined();
    expect(isNonPublicIp("010.0.0.1")).toBe(true);

    // Non-public IPv4 & IPv6 ranges
    for (const ip of [
      "100.64.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "ff02::1",
      "fd12:3456::1",
      "64:ff9b::127.0.0.1",
      "64:ff9b::8.8.8.8",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "[::1]",
      ":::",
      "1::2::3",
    ]) {
      expect(isNonPublicIp(ip), ip).toBe(true);
    }

    expect(parseIpLiteral("::ffff:8.8.8.8")?.class).toBe("public");
    expect(isNonPublicIp("2001:4860:4860::8888")).toBe(false);
    expect(isNonPublicIp("93.184.216.34")).toBe(false);
  });

  test("egress-tls-intercept-ca: validates RFC 1035 servername and fails closed without CA key fallback", () => {
    const dir = makeTemp("hz-tls-ca-");
    const fakeCert = path.join(dir, "missing-ca.pem");
    const fakeKey = path.join(dir, "missing-ca.key.pem");
    for (const bad of ["", "/CN=evil/O=bad", "evil.com/CN=good", "a b", "*.evil.com", "-bad.com", "a\nb"]) {
      expect(() => mintHermeticLeafCert(fakeCert, fakeKey, bad)).toThrow(/HZ_PRECONDITION_FAILED/);
    }
    // Missing CA files must fail closed (never return CA private key)
    expect(() => mintHermeticLeafCert(fakeCert, fakeKey, "api.example.com")).toThrow(/HZ_TLS_MINT_FAILED/);
  });

  test("effect-host-atomic-delete & rename: realpath/lstat containment and fail-closed sameDevice", async () => {
    const root = makeTemp("hz-atomic-root-");
    const outside = makeTemp("hz-atomic-out-");
    const insideFile = path.join(root, "a.txt");
    const renamedFile = path.join(root, "b.txt");
    const outFile = path.join(outside, "secret.txt");
    writeFileSync(insideFile, "hello");
    writeFileSync(outFile, "secret");

    await renameFileInSandbox(root, insideFile, renamedFile);
    expect(existsSync(renamedFile)).toBe(true);
    await expect(deleteFileInSandbox(root, outFile)).rejects.toThrow(/HZ_PRECONDITION_FAILED/);
    await expect(renameFileInSandbox(root, renamedFile, path.join(outside, "escaped.txt"))).rejects.toThrow(
      /HZ_PRECONDITION_FAILED/,
    );
    await deleteFileInSandbox(root, renamedFile);
    expect(existsSync(renamedFile)).toBe(false);

    if (process.platform !== "win32") {
      const link = path.join(root, "escape-link.txt");
      symlinkSync(outFile, link);
      await expect(deleteFileInSandbox(root, link)).rejects.toThrow(/HZ_PRECONDITION_FAILED/);
      await expect(renameFileInSandbox(root, link, path.join(root, "c.txt"))).rejects.toThrow(/HZ_PRECONDITION_FAILED/);
    }
  });

  test("code-mode-vm: blocks prototype properties, checks Object.hasOwn, bounds-checks NEW_CELL, and brands closures", () => {
    const obj = { ok: 42 };
    for (const prop of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        runBytecode({
          consts: [obj, prop],
          words: [Op.PUSH_CONST, 0, Op.GET_PROP, 1, Op.RETURN],
        }),
      ).toThrow(/forbidden property access/);
    }
    // Inherited property (`toString`) returns undefined via Object.hasOwn
    const inherited = runBytecode({
      consts: [obj, "toString"],
      words: [Op.PUSH_CONST, 0, Op.GET_PROP, 1, Op.RETURN],
    });
    expect(inherited.value).toBeUndefined();

    // NEW_CELL bounds checks
    expect(() => runBytecode({ consts: [], words: [Op.NEW_CELL, -1, Op.RETURN] })).toThrow(/cell index out of range/);
    expect(() => runBytecode({ consts: [], words: [Op.NEW_CELL, 2000, Op.RETURN] })).toThrow(/cell index out of range/);

    // Forged closure object cannot be invoked via CALL
    const forged = { start: 0, upvals: [] };
    expect(() =>
      runBytecode({
        consts: [forged],
        words: [Op.PUSH_CONST, 0, Op.CALL, 0, Op.RETURN],
      }),
    ).toThrow(/CALL target is not a function/);
  });
});

describe("Track 2 P1 — Auth, Catalog, Egress, Guardian, Skills/Profiles, Sandbox & Supervisor", () => {
  test("auth/refresh: isolates pendingByProvider by home and skips fetch when token is fresh after lock", async () => {
    const homeA = makeTemp("hz-oauth-a-");
    const homeB = makeTemp("hz-oauth-b-");
    await writeOAuthToken(
      {
        provider: "p1",
        accessToken: "fresh-a",
        refreshToken: "rt-a",
        obtainedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      homeA,
    );
    await writeOAuthToken(
      {
        provider: "p1",
        accessToken: "expired-b",
        refreshToken: "rt-b",
        obtainedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      },
      homeB,
    );
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: "new-b", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const endpoints = { clientId: "cid", authorizeUrl: "https://idp.example/auth", tokenUrl: "https://idp.example/tok" };

    const [a, b] = await Promise.all([
      refreshOAuthAccessToken("p1", endpoints, homeA, fetcher),
      refreshOAuthAccessToken("p1", endpoints, homeB, fetcher),
    ]);
    expect(calls).toBe(1);
    expect(a?.kind === "oauth" && a.accessToken).toBe("fresh-a");
    expect(b?.kind === "oauth" && b.accessToken).toBe("new-b");
  });

  test("catalog-poll: asserts assertCacheWrite before writeCatalogCacheMeta on 304 and unchanged-digest", async () => {
    const home = makeTemp("hz-cat-meta-");
    const providers: Record<string, unknown> = {};
    for (let i = 0; i < MINIMUM_PROVIDERS; i += 1) {
      const id = `p${i}`;
      const mid = `m${i}`;
      providers[id] = { id, defaultModel: mid, models: { [mid]: { id: mid, provider: id, limit: { context: 128000 } } } };
    }
    const cat = decodeCatalog({ providers });
    writeCatalogCache(cat, { updatedAt: 1, fetchedAt: new Date(1).toISOString(), etag: '"e1"', digest: "d1" }, home);

    let checks = 0;
    const res304 = await refreshModelsCatalog({
      home,
      now: () => 1_000_000,
      assertCacheWrite: async () => {
        checks += 1;
        throw new Error("denied meta write");
      },
      fetchLive: async () => ({ catalog: cat, notModified: true, etag: '"e1"' }),
    });
    expect(checks).toBe(1);
    expect(res304.status).toBe("error");

    const resDigest = await refreshModelsCatalog({
      home,
      now: () => 1_000_000,
      assertCacheWrite: async () => {
        checks += 1;
        throw new Error("denied digest meta write");
      },
      fetchLive: async () => ({ catalog: cat, notModified: false, etag: '"e2"', digest: "d1" }),
    });
    expect(checks).toBe(2);
    expect(resDigest.status).toBe("error");
  });

  test("egress-decider: trailing dots, subdomain denylist, and bracketed IPv6", () => {
    expect(normalizeNetworkRuleHost("Example.COM.")).toBe("example.com");
    expect(parseOrigin("https://api.example.com.:8443/v1")).toEqual({
      scheme: "https",
      host: "api.example.com",
      port: 8443,
    });
    expect(parseOrigin("https://[::1]:8443/x")).toEqual({ scheme: "https", host: "::1", port: 8443 });
    expect(originFromConnectAuthority("[2001:db8::1]:443")).toEqual({
      scheme: "https",
      host: "2001:db8::1",
      port: 443,
    });

    const policy = parseEgressPolicyDoc({
      rules: [{ host: "sub.evil.com", decision: "allow" }],
      disallowedWebFetchDomains: ["evil.com."],
    })!;
    expect(decideOrigin(policy, { scheme: "https", host: "sub.evil.com.", port: 443 })).toEqual({
      kind: "deny",
      source: "web_fetch_denylist",
    });
    expect(decideConnectAuthority(policy, "sub.evil.com.:443")).toEqual({
      kind: "deny",
      source: "web_fetch_denylist",
    });
  });

  test("egress-proxy-token: timingSafeEqual verify and eviction of expired/revoked tokens", () => {
    let now = 1000;
    const mgr = new ProxyTokenManager({ now: () => now, ttlMs: 100 });
    const t = mgr.issue("api.example.com", 443);
    expect(mgr.verify(t.token, "api.example.com", 443)).toBe(true);
    expect(mgr.revokeExact(t.id)).toBe(true);
    expect(mgr.revokeExact(t.id)).toBe(false);
    expect(mgr.verify(t.token, "api.example.com", 443)).toBe(false);

    const t2 = mgr.issue("api.example.com", 443);
    now += 200;
    expect(mgr.verify(t2.token, "api.example.com", 443)).toBe(false);
  });

  test("http-credential-inject: rejects invalid RFC 7230 header names and CR/LF/NUL values", () => {
    const broker = new CredentialBroker([
      { id: "bad-crlf", header: "authorization", value: "Bearer ok\r\nX-Injected: evil" },
      { id: "bad-nul", header: "authorization", value: "Bearer ok\0tail" },
      { id: "good", header: "authorization", value: "Bearer safe" },
    ]);
    const req = "GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n";
    expect(() =>
      injectCredentialHeaders(req, "api.example.com", broker, [
        { host: "api.example.com", header: "Bad Header", secretId: "good" },
      ]),
    ).toThrow(/invalid RFC 7230/);
    expect(() =>
      injectCredentialHeaders(req, "api.example.com", broker, [
        { host: "api.example.com", header: "Authorization", secretId: "bad-crlf" },
      ]),
    ).toThrow(/CR\/LF\/NUL/);
    expect(() =>
      injectCredentialHeaders(req, "api.example.com", broker, [
        { host: "api.example.com", header: "Authorization", secretId: "bad-nul" },
      ]),
    ).toThrow(/CR\/LF\/NUL/);
  });

  test("guardian & autonomy-envelope: normalizes backslashes and catches id_ed25519, .npmrc, .netrc, credentials.db", () => {
    for (const p of [
      "C:\\Users\\alice\\.ssh\\id_ed25519",
      "C:\\Users\\alice\\.npmrc",
      "foo\\..\\.netrc",
      "C:\\Users\\alice\\.config\\horizon\\credentials.db",
    ]) {
      expect(deterministicClassifier.classify({ tool: "write", kind: "fs.write", target: p }, "").verdict, p).toBe("deny");
      expect(isSystemBoundaryPath(p), p).toBe(true);
    }
  });

  test("skills & agent-profiles: gates .claude/skills and .hz/agents when workspace is untrusted", () => {
    const ws = makeTemp("hz-trust-ws-");
    const home = makeTemp("hz-trust-home-");
    const claudeSkillDir = path.join(ws, ".claude", "skills", "sneaky");
    mkdirSync(claudeSkillDir, { recursive: true });
    writeFileSync(path.join(claudeSkillDir, "SKILL.md"), "---\nname: sneaky\n---\nbody");
    const agentsDir = path.join(ws, ".hz", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "local.md"), "---\nname: local\ntools: read\n---\nbody");

    const skills = listSkills(ws, { trustedWorkspaceHooks: [], home });
    expect(skills.some((s) => s.name === "sneaky")).toBe(false);
    const presets = loadPresets(ws, { trustedWorkspaceHooks: [], home });
    expect(presets.presets.has("local")).toBe(false);
  });

  test("sandbox-fd-verify: removes !sameDir bypass when target mismatches expectedReal in same directory", async () => {
    const ws = makeTemp("hz-fd-same-dir-");
    const fileA = path.join(ws, "a.txt");
    const fileB = path.join(ws, "b.txt");
    writeFileSync(fileA, "a");
    writeFileSync(fileB, "b");
    const handle = await open(fileB, "r");
    try {
      const res = await verifyFdInWorkspace(handle, ws, fileB, fileA);
      expect("refusal" in res).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test("sandbox-netns-spawn-wrapped-exec-create-connect: veth names stay <= 14 chars (IFNAMSIZ)", () => {
    for (const suffix of [String(process.pid), `t${Date.now()}`, "very-long-suffix-123456789"]) {
      const { host, peer } = execCreateVethInterfaceNames(suffix);
      expect(host.length).toBeLessThanOrEqual(14);
      expect(peer.length).toBeLessThanOrEqual(14);
      expect(host).not.toBe(peer);
    }
  });

  test("supervisor: guards kill -9 -WORKER with owner liveness check", () => {
    const script = ownerDeathSupervisorScript(1234, 5678, 100);
    expect(script).toContain("if ! kill -0 1234 2>/dev/null; then kill -9 -5678 2>/dev/null; fi");
  });
});

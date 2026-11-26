import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Op } from "../../src/core/code-mode-vm";
import { disposeLiveDapSession } from "../../src/core/dap/registry";
import { applyPatchTool } from "../../src/tools/apply-patch";
import { askUserTool } from "../../src/tools/ask-user";
import { astEditTool } from "../../src/tools/ast-edit";
import { astSearchTool } from "../../src/tools/ast-search";
import { codeModeVmTool, MAX_STRING_LEN } from "../../src/tools/code-mode-vm";
import { actionForCall } from "../../src/tools/codemode";
import { CodemodeSessionKv } from "../../src/tools/codemode-kv";
import { debugTool } from "../../src/tools/debug";
import { editTool } from "../../src/tools/edit";
import { gitDiffTool, gitStatusTool } from "../../src/tools/git-read";
import { globTool } from "../../src/tools/glob";
import { grepTool } from "../../src/tools/grep";
import { scrubEnv } from "../../src/tools/helpers";
import {
  interactiveExecTool,
  rawForSpillLengthForTest,
  resetSessionsForTest,
} from "../../src/tools/interactive-exec";
import { lintTool } from "../../src/tools/lint";
import { previewTool, stopAllPreviews } from "../../src/tools/preview";
import { noteRead } from "../../src/tools/read-ledger";
import { readTool } from "../../src/tools/read";
import {
  __setWebFetchDnsLookupForTests,
  __setWebFetchHttpForTests,
  isBlockedPrivateHost,
  webFetchTool,
} from "../../src/tools/web-fetch";
import {
  __resetWebSearchBudgetForTests,
  __setWebSearchHttpForTests,
  webSearchTool,
} from "../../src/tools/web-search";
import { makeWorkspace, mockToolContext } from "./helpers";

afterEach(async () => {
  resetSessionsForTest();
  __setWebFetchHttpForTests(undefined);
  __setWebFetchDnsLookupForTests(undefined);
  __setWebSearchHttpForTests(undefined);
  __resetWebSearchBudgetForTests();
  await stopAllPreviews();
});

describe("Track 3 Z-P0-4: git-read hardening", () => {
  test("ignores malicious repo .git/config diff.external and core.fsmonitor", async () => {
    const ws = makeWorkspace({ "a.txt": "hello\n" });
    const marker = path.join(ws, "pwned.txt");
    execFileSync("git", ["init"], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["add", "a.txt"], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["config", "diff.external", `touch ${marker}`], { cwd: ws, stdio: "ignore" });
    execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}`], { cwd: ws, stdio: "ignore" });
    writeFileSync(path.join(ws, "a.txt"), "changed\n");

    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    const status = await gitStatusTool.execute({}, ctx);
    expect(status.ok).toBe(true);
    const diff = await gitDiffTool.execute({}, ctx);
    expect(diff.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Track 3 P1-9: interactive-exec hardening", () => {
  test("refuses write/close from a different ctx.sessionId", async () => {
    const before = process.env.HZ_NO_PTY;
    process.env.HZ_NO_PTY = "1";
    try {
      const ws = makeWorkspace({});
      const ctxA = mockToolContext({ cwd: ws, sessionId: "sess-A", decision: () => ({ decision: "allow" }) });
      const ctxB = mockToolContext({ cwd: ws, sessionId: "sess-B", decision: () => ({ decision: "allow" }) });
      const started = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctxA);
      expect(started.ok).toBe(true);
      const sid = (started.output.match(/Session: (\S+)/) as RegExpMatchArray)[1]!;

      const wOther = await interactiveExecTool.execute({ mode: "write", sessionId: sid, input: "hi\n" }, ctxB);
      expect(wOther.ok).toBe(false);
      expect(wOther.error).toContain("different chat session");

      const cOther = await interactiveExecTool.execute({ mode: "close", sessionId: sid }, ctxB);
      expect(cOther.ok).toBe(false);
      expect(cOther.error).toContain("different chat session");

      const cOwner = await interactiveExecTool.execute({ mode: "close", sessionId: sid }, ctxA);
      expect(cOwner.ok).toBe(true);
    } finally {
      if (before === undefined) delete process.env.HZ_NO_PTY;
      else process.env.HZ_NO_PTY = before;
    }
  });

  test("enforces shellCompoundRefusal on start and write", async () => {
    const before = process.env.HZ_NO_PTY;
    process.env.HZ_NO_PTY = "1";
    try {
      const ws = makeWorkspace({});
      const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
      const badStart = await interactiveExecTool.execute({ mode: "start", command: "echo $(whoami)" }, ctx);
      expect(badStart.ok).toBe(false);

      const started = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
      expect(started.ok).toBe(true);
      const sid = (started.output.match(/Session: (\S+)/) as RegExpMatchArray)[1]!;
      const badWrite = await interactiveExecTool.execute({ mode: "write", sessionId: sid, input: "echo $(id)\n" }, ctx);
      expect(badWrite.ok).toBe(false);
      await interactiveExecTool.execute({ mode: "close", sessionId: sid }, ctx);
    } finally {
      if (before === undefined) delete process.env.HZ_NO_PTY;
      else process.env.HZ_NO_PTY = before;
    }
  });

  test("caps rawForSpill and prunes 4 exited sessions so MAX_SESSIONS is not permanently exhausted", async () => {
    const before = process.env.HZ_NO_PTY;
    process.env.HZ_NO_PTY = "1";
    try {
      const ws = makeWorkspace({});
      const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });

      // Start 4 sessions that exit after SETTLE_MS via short overall timeout
      for (let i = 0; i < 4; i++) {
        const s = await interactiveExecTool.execute(
          { mode: "start", command: "sleep 10", timeoutMs: 200 },
          ctx,
        );
        expect(s.ok).toBe(true);
      }
      await Bun.sleep(600);
      // 5th session must succeed because the 4 exited sessions are pruned
      const fifth = await interactiveExecTool.execute({ mode: "start", command: "cat" }, ctx);
      expect(fifth.ok).toBe(true);
      const sid = (fifth.output.match(/Session: (\S+)/) as RegExpMatchArray)[1]!;
      expect(rawForSpillLengthForTest(sid)).toBeLessThanOrEqual(60_000);
      await interactiveExecTool.execute({ mode: "close", sessionId: sid }, ctx);
    } finally {
      if (before === undefined) delete process.env.HZ_NO_PTY;
      else process.env.HZ_NO_PTY = before;
    }
  });
});

describe("Track 3 P1-10: web-fetch and web-search SSRF + DNS hardening", () => {
  test("isBlockedPrivateHost blocks CGNAT, multicast, NAT64, and uncompressed IPv4-mapped IPv6", () => {
    expect(isBlockedPrivateHost("100.64.0.1")).toBe(true);
    expect(isBlockedPrivateHost("100.127.255.254")).toBe(true);
    expect(isBlockedPrivateHost("224.0.0.1")).toBe(true);
    expect(isBlockedPrivateHost("239.255.255.250")).toBe(true);
    expect(isBlockedPrivateHost("ff02::1")).toBe(true);
    expect(isBlockedPrivateHost("64:ff9b::127.0.0.1")).toBe(true);
    expect(isBlockedPrivateHost("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isBlockedPrivateHost("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isBlockedPrivateHost("93.184.216.34")).toBe(false);
    expect(isBlockedPrivateHost("100.128.0.1")).toBe(false);
  });

  test("pre-fetch DNS check rejects hostname resolving to private IP in web_fetch and web_search", async () => {
    let fetchCalled = false;
    __setWebFetchHttpForTests(async () => {
      fetchCalled = true;
      return new Response("ok");
    });
    __setWebFetchDnsLookupForTests(async () => [{ address: "100.64.0.5", family: 4 }]);

    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    const res = await webFetchTool.execute({ url: "https://rebind.example.com/secret" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("blocked private address");
    expect(fetchCalled).toBe(false);

    const prevWs = process.env.HZ_WEB_SEARCH;
    process.env.HZ_WEB_SEARCH = "1";
    __setWebSearchHttpForTests(async () => {
      fetchCalled = true;
      return new Response("ok");
    });
    try {
      const sres = await webSearchTool.execute({ query: "test" }, ctx);
      expect(sres.ok).toBe(false);
      expect(sres.error).toContain("blocked private address");
      expect(fetchCalled).toBe(false);
    } finally {
      if (prevWs === undefined) delete process.env.HZ_WEB_SEARCH;
      else process.env.HZ_WEB_SEARCH = prevWs;
    }
  });
});

describe("Track 3 P1-11: scrubEnv broadened regex", () => {
  test("scrubs broadened credential names while preserving safe vars", () => {
    const keys = [
      "PRIVATE_KEY_PEM",
      "JWT_SECRET_B64",
      "NPM_CONFIG__AUTH",
      "DOCKER_AUTH_CONFIG",
      "SSH_AUTH_SOCK",
      "KUBECONFIG",
      "SESSION_COOKIE",
      "HZ_SAFE_FLAG",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    process.env.PRIVATE_KEY_PEM = "pem";
    process.env.JWT_SECRET_B64 = "b64";
    process.env.NPM_CONFIG__AUTH = "tok";
    process.env.DOCKER_AUTH_CONFIG = "{}";
    process.env.SSH_AUTH_SOCK = "/tmp/agent";
    process.env.KUBECONFIG = "/tmp/kube";
    process.env.SESSION_COOKIE = "abc";
    process.env.HZ_SAFE_FLAG = "1";
    try {
      const env = scrubEnv();
      expect(env.PRIVATE_KEY_PEM).toBeUndefined();
      expect(env.JWT_SECRET_B64).toBeUndefined();
      expect(env.NPM_CONFIG__AUTH).toBeUndefined();
      expect(env.DOCKER_AUTH_CONFIG).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.KUBECONFIG).toBeUndefined();
      expect(env.SESSION_COOKIE).toBeUndefined();
      expect(env.HZ_SAFE_FLAG).toBe("1");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("Track 3 P1-13: debug stderr drain and live-session reuse without command/adapter", () => {
  test("drains >100 KiB stderr without deadlock and reuses live session without command/adapter", async () => {
    const ws = makeWorkspace({});
    const adapterPath = path.join(ws, "noisy-dap.mjs");
    writeFileSync(
      adapterPath,
      `#!/usr/bin/env bun
// Write >100 KiB to stderr immediately (would deadlock an undrained 64 KiB pipe)
process.stderr.write("E".repeat(120_000) + "\\n");
let buf = Buffer.alloc(0);
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx === -1) break;
    const hdr = buf.slice(0, idx).toString("utf8");
    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
    if (!m) break;
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) break;
    const msg = JSON.parse(buf.slice(idx + 4, idx + 4 + len).toString("utf8"));
    buf = buf.slice(idx + 4 + len);
    if (msg.command === "initialize") {
      send({ seq: 1, type: "response", request_seq: msg.seq, success: true, command: "initialize", body: {} });
      send({ seq: 2, type: "event", event: "initialized" });
    } else if (msg.command === "launch") {
      send({ seq: 3, type: "response", request_seq: msg.seq, success: true, command: "launch" });
    } else if (msg.command === "configurationDone") {
      send({ seq: 4, type: "response", request_seq: msg.seq, success: true, command: "configurationDone" });
      send({ seq: 5, type: "event", event: "stopped", body: { reason: "entry", threadId: 1 } });
    } else if (msg.command === "threads") {
      send({ seq: 6, type: "response", request_seq: msg.seq, success: true, command: "threads", body: { threads: [{ id: 1, name: "main" }] } });
    } else if (msg.command === "stackTrace") {
      send({ seq: 7, type: "response", request_seq: msg.seq, success: true, command: "stackTrace", body: { stackFrames: [{ id: 10, name: "main", line: 1 }] } });
    } else if (msg.command === "scopes") {
      send({ seq: 8, type: "response", request_seq: msg.seq, success: true, command: "scopes", body: { scopes: [{ name: "Locals", variablesReference: 20 }] } });
    } else if (msg.command === "variables") {
      send({ seq: 9, type: "response", request_seq: msg.seq, success: true, command: "variables", body: { variables: [{ name: "x", value: "42" }] } });
    } else if (msg.command === "next") {
      send({ seq: 10, type: "response", request_seq: msg.seq, success: true, command: "next" });
      send({ seq: 11, type: "event", event: "stopped", body: { reason: "step", threadId: 1 } });
    }
  }
});
`,
    );
    chmodSync(adapterPath, 0o755);
    const ctx = mockToolContext({ cwd: ws, sessionId: "dap-track3", decision: () => ({ decision: "allow" }) });
    try {
      const launched = await debugTool.execute(
        { op: "launch", command: adapterPath, program: "app.py" },
        ctx,
      );
      expect(launched.ok).toBe(true);

      // stack, variables, and next must work WITHOUT passing command or adapter
      const stack = await debugTool.execute({ op: "stack" }, ctx);
      expect(stack.ok).toBe(true);
      expect(stack.output).toContain("main");

      const vars = await debugTool.execute({ op: "variables" }, ctx);
      expect(vars.ok).toBe(true);
      expect(vars.output).toContain("x = 42");

      const stepped = await debugTool.execute({ op: "next" }, ctx);
      expect(stepped.ok).toBe(true);
      expect(stepped.output).toContain("live session reused");
    } finally {
      await disposeLiveDapSession(ws, "dap-track3");
    }
  });
});

describe("Track 3 P1-14: ask_user AbortController timeout & turn abort", () => {
  test("passes signal to askUser and aborts waiter on timeout and ctx.signal abort", async () => {
    const ws = makeWorkspace({});
    let receivedSignal: AbortSignal | undefined;

    // Timeout aborts signal
    const ctx1 = mockToolContext({
      cwd: ws,
      askUser: ((_req: unknown, signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<string>(() => {});
      }) as never,
    });
    const r1 = await askUserTool.execute({ question: "Pick?", timeout_ms: 30, default: "A", options: ["A", "B"] }, ctx1);
    expect(r1.ok).toBe(true);
    expect(r1.output).toBe("A");
    expect(receivedSignal?.aborted).toBe(true);

    // Parent ctx.signal abort cancels waiter and fails without falling back to default
    const ac = new AbortController();
    let receivedSignal2: AbortSignal | undefined;
    const ctx2 = mockToolContext({
      cwd: ws,
      askUser: ((_req: unknown, signal?: AbortSignal) => {
        receivedSignal2 = signal;
        return new Promise<string>(() => {});
      }) as never,
    });
    ctx2.signal = ac.signal;
    setTimeout(() => ac.abort(new Error("turn cancelled")), 20);
    const r2 = await askUserTool.execute({ question: "Pick?", default: "A", options: ["A", "B"] }, ctx2);
    expect(r2.ok).toBe(false);
    expect(receivedSignal2?.aborted).toBe(true);
  });
});

describe("Track 3 P1-17: apply-patch, edit, ast-edit, ast-search hardening", () => {
  test("apply_patch Add File re-checks existence inside file lock after approval", async () => {
    const ws = makeWorkspace({});
    const targetPath = path.join(ws, "race.txt");
    const ctx = mockToolContext({
      cwd: ws,
      decision: () => ({ decision: "ask" }),
      approve: async () => {
        // Simulate concurrent creator during approval window
        writeFileSync(targetPath, "created-concurrently\n");
        return true;
      },
    });
    const patch = "*** Begin Patch\n*** Add File: race.txt\n+from-patch\n*** End Patch";
    const res = await applyPatchTool.execute({ input: patch }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HZ_PRECONDITION_FAILED");
    expect(readFileSync(targetPath, "utf8")).toBe("created-concurrently\n");
  });

  test("apply_patch Delete File safely unlinks symlink without removing target", async () => {
    const ws = makeWorkspace({ "real.txt": "keep me\n" });
    const linkPath = path.join(ws, "link.txt");
    symlinkSync(path.join(ws, "real.txt"), linkPath);
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    const patch = "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch";
    const res = await applyPatchTool.execute({ input: patch }, ctx);
    expect(res.ok).toBe(true);
    expect(existsSync(linkPath)).toBe(false);
    expect(existsSync(path.join(ws, "real.txt"))).toBe(true);
  });

  test("edit and ast_edit do not leak outside-workspace file existence before approval", async () => {
    const ws = makeWorkspace({});
    const outsideMissing = path.join(os.tmpdir(), `hz-track3-missing-${Date.now()}.ts`);
    let approveCalls = 0;
    const ctx = mockToolContext({
      cwd: ws,
      decision: () => ({ decision: "ask" }),
      approve: async () => {
        approveCalls += 1;
        return false;
      },
    });

    const editRes = await editTool.execute({ path: outsideMissing, old: "a", new: "b" }, ctx);
    expect(editRes.ok).toBe(false);
    expect(editRes.error).toBe("declined by user");
    expect(approveCalls).toBe(1);

    const astRes = await astEditTool.execute({ path: outsideMissing, pat: "foo($A)", out: "bar($A)" }, ctx);
    expect(astRes.ok).toBe(false);
    expect(astRes.error).toBe("declined by user");
    expect(approveCalls).toBe(2);
  });

  test("ast_search skips symlinks inside workspace during selfContainedSearch", async () => {
    const outsideDir = makeWorkspace({ "secret.ts": "needle(1);\n" });
    const ws = makeWorkspace({ "local.ts": "other(2);\n" });
    symlinkSync(path.join(outsideDir, "secret.ts"), path.join(ws, "linked.ts"));
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    const res = await astSearchTool.execute({ pat: "needle($A)" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).not.toContain("linked.ts");
    expect(res.output).not.toContain("needle(1)");
  });
});

describe("Track 3 P1-18 & P2: code-mode-vm, codemode-kv, codemode", () => {
  test("code_mode_vm caps localCount <= 1024 and blocks string-doubling Op.ADD DoS", async () => {
    const ws = makeWorkspace({});
    const ctx = mockToolContext({ cwd: ws });

    const tooManyLocals = await codeModeVmTool.execute(
      { words: [Op.PUSH_INT, 1, Op.RETURN], localCount: 2048 },
      ctx,
    );
    expect(tooManyLocals.ok).toBe(false);
    expect(tooManyLocals.error).toContain("localCount");

    const bigConst = await codeModeVmTool.execute(
      { words: [Op.PUSH_CONST, 0, Op.RETURN], consts: ["a".repeat(MAX_STRING_LEN + 1)] },
      ctx,
    );
    expect(bigConst.ok).toBe(false);
    expect(bigConst.error).toContain("MAX_STRING_LEN");

    // Loop with Op.ADD + string const
    const loopDoubling = await codeModeVmTool.execute(
      { words: [Op.PUSH_CONST, 0, Op.DUP, Op.ADD, Op.JUMP, 2, Op.RETURN], consts: ["aaaa"] },
      ctx,
    );
    expect(loopDoubling.ok).toBe(false);
    expect(loopDoubling.error).toContain("MAX_STRING_LEN");
  });

  test("CodemodeSessionKv uses null-prototype object and validates MAX_KV_BYTES before mutating", () => {
    const ws = makeWorkspace({});
    const kv = new CodemodeSessionKv(ws, "kv-track3");
    expect(Object.getPrototypeOf(kv.snapshot())).toBeNull();
    kv.set("ok", "small");
    expect(() => kv.set("huge", "x".repeat(2_100_000))).toThrow("exceeds");
    // In-memory state must remain unmutated after rejected set()
    expect(kv.get("huge")).toBeUndefined();
    expect(kv.get("ok")).toBe("small");
  });

  test("actionForCall handles batch read paths", () => {
    const act = actionForCall("read", { paths: ["a.ts", "../outside.txt"] }, "/repo/ws");
    expect(act).toBeDefined();
    expect(act?.kind).toBe("fs.read");
    expect(act?.target).toBe(path.resolve("/repo/ws", "../outside.txt"));
  });
});

describe("Track 3 P2: read, glob, grep, preview, lint, web-search hardening", () => {
  test("read caps batch paths <= 20 and enforces shared 200 KiB budget across batch", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`f${i}.txt`] = "a".repeat(80 * 1024) + "\n";
    const ws = makeWorkspace(files);
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });

    const tooMany = await readTool.execute(
      { paths: Array.from({ length: 21 }, (_, i) => `f${i}.txt`) },
      ctx,
    );
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toContain("at most 20");

    const batch = await readTool.execute({ paths: ["f0.txt", "f1.txt", "f2.txt", "f3.txt"] }, ctx);
    expect(batch.ok).toBe(true);
    const parsed = JSON.parse(batch.output) as Array<{ ok: boolean; output?: string; error?: string }>;
    const totalOut = parsed.reduce((sum, item) => sum + (item.output ? Buffer.byteLength(item.output, "utf8") : 0), 0);
    // Shared budget caps total content well under 4 * 80 KiB (320 KiB)
    expect(totalOut).toBeLessThan(240 * 1024);
    expect(parsed.some((p) => !p.ok || (p.output?.includes("truncated") ?? false))).toBe(true);
  });

  test("glob skips .hz and .hzcode directories", async () => {
    const ws = makeWorkspace({
      "src/app.ts": "export const x = 1;\n",
      ".hz/state/secret.ts": "hidden\n",
      ".hzcode/old.ts": "hidden\n",
    });
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    const res = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("src/app.ts");
    expect(res.output).not.toContain(".hz");
    expect(res.output).not.toContain(".hzcode");
  });

  test("grep respects ctx.signal abort", async () => {
    const ws = makeWorkspace({ "a.txt": "hello world\n" });
    const ac = new AbortController();
    ac.abort();
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    ctx.signal = ac.signal;
    const res = await grepTool.execute({ pattern: "hello" }, ctx);
    expect(res.ok).toBe(true);
  });

  test("preview aborts immediately during URL wait loop when ctx.signal aborts", async () => {
    const ws = makeWorkspace({});
    const ac = new AbortController();
    const ctx = mockToolContext({ cwd: ws, decision: () => ({ decision: "allow" }) });
    ctx.signal = ac.signal;
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const res = await previewTool.execute({ action: "start", command: "sleep 30" }, ctx);
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
    expect(elapsed).toBeLessThan(3000);
  });

  test("lint uses concurrencyClass exclusive", () => {
    expect(lintTool.concurrencyClass).toBe("exclusive");
  });

  test("web_search turnQueryCount is isolated per ctx.sessionId", async () => {
    const prevWs = process.env.HZ_WEB_SEARCH;
    const prevMax = process.env.HZ_WEB_SEARCH_MAX_QUERIES;
    process.env.HZ_WEB_SEARCH = "1";
    process.env.HZ_WEB_SEARCH_MAX_QUERIES = "1";
    __setWebSearchHttpForTests(
      async () =>
        new Response(
          `<div class="result"><a class="result__a" href="https://example.com">Example</a></div></div>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );
    try {
      const ws = makeWorkspace({});
      const ctxA = mockToolContext({ cwd: ws, sessionId: "ws-A", decision: () => ({ decision: "allow" }) });
      const ctxB = mockToolContext({ cwd: ws, sessionId: "ws-B", decision: () => ({ decision: "allow" }) });

      const a1 = await webSearchTool.execute({ query: "alpha" }, ctxA);
      expect(a1.ok).toBe(true);
      const a2 = await webSearchTool.execute({ query: "beta" }, ctxA);
      expect(a2.ok).toBe(false);
      expect(a2.error).toContain("budget exceeded");

      // Different session B still has its own fresh turn budget
      const b1 = await webSearchTool.execute({ query: "gamma" }, ctxB);
      expect(b1.ok).toBe(true);
    } finally {
      if (prevWs === undefined) delete process.env.HZ_WEB_SEARCH;
      else process.env.HZ_WEB_SEARCH = prevWs;
      if (prevMax === undefined) delete process.env.HZ_WEB_SEARCH_MAX_QUERIES;
      else process.env.HZ_WEB_SEARCH_MAX_QUERIES = prevMax;
    }
  });
});

/**
 * audit-wave-track5.test.ts — Track 5 P0/P1/P2 security regression tests:
 * 1. P0: tunnelPermissionError(e) across tool catch blocks (never swallows PermissionDeclinedError / PermissionCorrectedError).
 * 2. P0: codemode.ts rpcChain.catch -> failWithThrow + runTool tunnelPermissionError.
 * 3. P0: edit.ts dirtyCheckpointPrefix moved after approval & inside lock; executeAnchored recordChangeGuarded passes path:real, workspace.
 * 4. P0: debug.ts explicit admitShellExec before launch/attach/step.
 * 5. P0: shell.ts & interactive-exec.ts resolveRealTarget cwd + fs.read guard + GuardAction.detail + buffered partial stdin.
 * 6. P1: undo.ts, apply-patch.ts, read.ts, git-read.ts, present.ts, web-fetch.ts, web-search.ts hardening.
 * 7. P1/P2: main.ts, grow.ts, scripts/refresh-models-snapshot.ts fixes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PermissionCorrectedError, PermissionDeclinedError } from "../../src/core/guards/defect-tunnel";
import { disposeAllLiveDapSessions } from "../../src/core/dap/registry";
import { applyPatchTool } from "../../src/tools/apply-patch";
import { astEditTool } from "../../src/tools/ast-edit";
import { astSearchTool } from "../../src/tools/ast-search";
import { debugTool } from "../../src/tools/debug";
import { editTool } from "../../src/tools/edit";
import { gitStatusTool } from "../../src/tools/git-read";
import { globTool } from "../../src/tools/glob";
import { grepTool } from "../../src/tools/grep";
import { interactiveExecTool, resetSessionsForTest } from "../../src/tools/interactive-exec";
import { lintTool } from "../../src/tools/lint";
import { lspTool } from "../../src/tools/lsp";
import { presentTool } from "../../src/tools/present";
import { previewTool } from "../../src/tools/preview";
import { readTool } from "../../src/tools/read";
import { repoMapTool } from "../../src/tools/repo-map";
import { shellTool } from "../../src/tools/shell";
import { todoTool } from "../../src/tools/todo";
import { undoTool } from "../../src/tools/undo";
import { isBlockedPrivateHost, normalizeUrl, webFetchTool } from "../../src/tools/web-fetch";
import {
  __resetWebSearchBudgetForTests,
  __setWebSearchHttpForTests,
  getWebSearchBudgetStats,
  resetWebSearchTurnBudget,
  webSearchTool,
} from "../../src/tools/web-search";
import { writeTool } from "../../src/tools/write";
import {
  buildCandidateUrls,
  fetchValidatedCatalog,
  writeSnapshotAtomic,
} from "../../scripts/refresh-models-snapshot";
import { makeWorkspace, mockToolContext } from "../tools/helpers";

afterEach(async () => {
  resetSessionsForTest();
  await disposeAllLiveDapSessions();
  __setWebSearchHttpForTests(undefined);
  __resetWebSearchBudgetForTests();
});

describe("Track 5 P0: tunnelPermissionError propagates through tool catch blocks", () => {
  function throwingCtx(ws: string, err: Error) {
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask" });
    ctx.approve = async () => {
      throw err;
    };
    return ctx;
  }

  test("read, write, edit, glob, grep, ast_search, ast_edit, lsp, lint, repo_map, shell, preview, web_fetch tunnel PermissionDeclinedError", async () => {
    const ws = makeWorkspace({ "a.txt": "hello world\n", "a.ts": "const x = 1;\n" });
    const declined = new PermissionDeclinedError("user declined");

    await expect(readTool.execute({ path: "a.txt" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(writeTool.execute({ path: "b.txt", content: "hi" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(editTool.execute({ path: "a.txt", old: "hello", new: "bye" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(globTool.execute({ pattern: "*.txt" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(grepTool.execute({ pattern: "hello" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(astSearchTool.execute({ pat: "const $X = 1" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    const astEditCtx = throwingCtx(ws, declined);
    const seedRead = mockToolContext({ cwd: ws, workspace: ws, sessionId: astEditCtx.sessionId, decision: "allow" });
    await readTool.execute({ path: "a.ts" }, seedRead);
    await expect(astEditTool.execute({ path: "a.ts", pat: "const $X = 1", out: "const $X = 2" }, astEditCtx)).rejects.toBe(declined);
    await expect(lspTool.execute({ path: "a.ts" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(lintTool.execute({ path: "a.ts" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(repoMapTool.execute({}, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(shellTool.execute({ command: "echo hi" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(interactiveExecTool.execute({ mode: "start", command: "echo hi" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(previewTool.execute({ action: "start", command: "echo hi" }, throwingCtx(ws, declined))).rejects.toBe(declined);
    await expect(webFetchTool.execute({ url: "https://example.com" }, throwingCtx(ws, declined))).rejects.toBe(declined);
  });

  test("PermissionCorrectedError also tunnels through tool catch blocks", async () => {
    const ws = makeWorkspace({ "a.txt": "hello\n" });
    const corrected = new PermissionCorrectedError("use a safer path");
    await expect(readTool.execute({ path: "a.txt" }, throwingCtx(ws, corrected))).rejects.toBe(corrected);
    await expect(shellTool.execute({ command: "echo hi" }, throwingCtx(ws, corrected))).rejects.toBe(corrected);
  });

  test("codemode.ts wires rpcChain.catch to failWithThrow and tunnels permission errors in runTool", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../src/tools/codemode.ts"), "utf8");
    expect(src).toContain("const failWithThrow = (err: unknown): void =>");
    expect(src).toContain("process.kill(-child.pid, \"SIGKILL\")");
    expect(src).toContain("rpcChain = rpcChain.then(() => handleRpc(message)).catch((err) => {");
    expect(src).toContain("failWithThrow(err);");
    expect(src).toContain("tunnelPermissionError(err);");
  });
});

describe("Track 5 P0: debug.ts explicit shell.exec admission", () => {
  test("launch, attach, and step refuse when shell.exec is denied without spawning adapter", async () => {
    const ctx = mockToolContext({
      decision: (a) => (a.kind === "shell.exec" ? { decision: "deny", reason: "no exec" } : { decision: "allow" }),
    });
    const launchRes = await debugTool.execute({ op: "launch", program: "node app.js", command: "bun" }, ctx);
    expect(launchRes.ok).toBe(false);
    expect(launchRes.error).toContain("no exec");
    expect(ctx.guardCalls.some((a) => a.kind === "shell.exec" && a.target === "node app.js")).toBe(true);
    expect(ctx.guardCalls.some((a) => a.kind === "spawn")).toBe(false);

    const attachCtx = mockToolContext({
      decision: (a) => (a.kind === "shell.exec" ? { decision: "deny", reason: "no attach" } : { decision: "allow" }),
    });
    const attachRes = await debugTool.execute({ op: "attach", pid: 1234, command: "bun" }, attachCtx);
    expect(attachRes.ok).toBe(false);
    expect(attachRes.error).toContain("no attach");
    expect(attachCtx.guardCalls.some((a) => a.kind === "shell.exec" && a.target === "attach:pid=1234")).toBe(true);
  });
});

describe("Track 5 P0: shell.ts & interactive-exec.ts cwd resolution and buffered partial stdin", () => {
  test("shell.ts guards fs.read when cwd is outside workspace and includes cwd in GuardAction.detail + approval prompt", async () => {
    const ws = makeWorkspace({ "sub/x.txt": "1" });
    const outside = mkdtempSync(path.join(tmpdir(), "hz-track5-outside-"));
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask", approve: true });
    // Denied on fs.read blocks outside cwd before shell.exec
    const denyCtx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (a) => (a.kind === "fs.read" ? { decision: "deny", reason: "outside cwd" } : { decision: "allow" }),
    });
    const denied = await shellTool.execute({ command: "echo hi", cwd: outside }, denyCtx);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("outside cwd");
    expect(denyCtx.guardCalls[0]?.kind).toBe("fs.read");

    // Inside custom subdir: GuardAction.detail carries cwd and approval prompt mentions cwd
    const subCtx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask", approve: false });
    const declined = await shellTool.execute({ command: "echo hi", cwd: "sub" }, subCtx);
    expect(declined.ok).toBe(false);
    const execAction = subCtx.guardCalls.find((a) => a.kind === "shell.exec");
    expect(execAction?.detail?.cwd).toBeDefined();
    expect(subCtx.approveCalls[0]?.detail).toContain("cwd:");
    expect(ctx).toBeDefined();
  });

  test("interactive-exec.ts guards outside cwd and includes cwd in GuardAction.detail", async () => {
    const ws = makeWorkspace({ "sub/x.txt": "1" });
    const outside = mkdtempSync(path.join(tmpdir(), "hz-track5-iexec-out-"));
    const denyCtx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (a) => (a.kind === "fs.read" ? { decision: "deny", reason: "outside iexec cwd" } : { decision: "allow" }),
    });
    const res = await interactiveExecTool.execute({ mode: "start", command: "echo hi", cwd: outside }, denyCtx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("outside iexec cwd");
  });

  test("interactive-exec.ts buffers unterminated partial line in parent memory (not written to child stdin until newline)", async () => {
    const before = process.env.HZ_NO_PTY;
    process.env.HZ_NO_PTY = "1";
    try {
      const ws = makeWorkspace({});
      const ctx = mockToolContext({
        cwd: ws,
        workspace: ws,
        decision: (a) => (a.target === "bad-cmd" ? { decision: "deny", reason: "blocked" } : { decision: "allow" }),
      });
      // Use a small node script that immediately echoes any raw stdin bytes it receives
      const start = await interactiveExecTool.execute(
        { mode: "start", command: `bun -e "process.stdin.on('data', d => process.stdout.write('GOT:' + d.toString()))"` },
        ctx,
      );
      expect(start.ok).toBe(true);
      const id = (start.output.match(/Session: (\S+)/) as RegExpMatchArray)[1]!;
      // Write unterminated fragment: must stay buffered in parent, NOT reach child stdin
      const partial = await interactiveExecTool.execute({ mode: "write", sessionId: id, input: "bad-" }, ctx);
      expect(partial.ok).toBe(true);
      expect(partial.output).not.toContain("GOT:bad-");
      // Completing with denied line must refuse without child ever seeing "bad-"
      const denied = await interactiveExecTool.execute({ mode: "write", sessionId: id, input: "cmd\n" }, ctx);
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("blocked");
      await interactiveExecTool.execute({ mode: "close", sessionId: id }, ctx);
    } finally {
      if (before === undefined) delete process.env.HZ_NO_PTY;
      else process.env.HZ_NO_PTY = before;
    }
  });
});

describe("Track 5 P1: File, Git, Present, WebFetch & WebSearch hardening", () => {
  test("undo.ts guards BEFORE reading the file on disk", async () => {
    const ws = makeWorkspace({ "f.txt": "v1\n" });
    const allowCtx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });
    await readTool.execute({ path: "f.txt" }, allowCtx);
    const editRes = await editTool.execute({ path: "f.txt", old: "v1", new: "v2" }, allowCtx);
    expect(editRes.ok).toBe(true);
    // Delete the file so a read-before-guard would fail with HZ_PRECONDITION_FAILED instead of policy deny
    unlinkSync(path.join(ws, "f.txt"));
    const denyCtx = mockToolContext({
      cwd: ws,
      workspace: ws,
      sessionId: allowCtx.sessionId,
      decision: "deny",
      decisionReason: "undo blocked",
    });
    const undoRes = await undoTool.execute({ path: "f.txt" }, denyCtx);
    expect(undoRes.ok).toBe(false);
    expect(undoRes.error).toContain("denied by policy: undo blocked");
  });

  test("apply-patch.ts guards BEFORE reading file and creates parent dirs on add", async () => {
    const ws = makeWorkspace({});
    const denyCtx = mockToolContext({ cwd: ws, workspace: ws, decision: "deny", decisionReason: "patch denied" });
    const patch = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-a\n+b\n*** End Patch";
    const denied = await applyPatchTool.execute({ input: patch }, denyCtx);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("denied by policy: patch denied");

    const allowCtx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });
    const addPatch = "*** Begin Patch\n*** Add File: nested/deep/new.txt\n+hello\n*** End Patch";
    const added = await applyPatchTool.execute({ input: addPatch }, allowCtx);
    expect(added.ok).toBe(true);
    expect(readFileSync(path.join(ws, "nested/deep/new.txt"), "utf8")).toBe("hello\n");
  });

  test("read.ts detects symlink swap during checkAccess (TOCTOU)", async () => {
    const ws = makeWorkspace({ "inside.txt": "safe\n" });
    const outside = mkdtempSync(path.join(tmpdir(), "hz-track5-read-out-"));
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "TOP_SECRET\n");
    const targetPath = path.join(ws, "inside.txt");

    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask" });
    ctx.approve = async () => {
      // Simulate racer swapping inside.txt -> symlink to outside secret during approval
      unlinkSync(targetPath);
      symlinkSync(secret, targetPath);
      return true;
    };
    const res = await readTool.execute({ path: "inside.txt" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HZ_PRECONDITION_FAILED");
    expect(res.output).not.toContain("TOP_SECRET");
  });

  test("present.ts and git-read.ts reject workspace-escaping paths via resolveRealTarget", async () => {
    const ws = makeWorkspace({});
    const outside = mkdtempSync(path.join(tmpdir(), "hz-track5-escape-"));
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });

    const pres = await presentTool.execute({ files: [path.join(outside, "evil.txt")] }, ctx);
    expect(pres.ok).toBe(false);
    expect(pres.error).toContain("escapes workspace");

    const git = await gitStatusTool.execute({ cwd: outside }, ctx);
    expect(git.ok).toBe(false);
    expect(git.error).toContain("inside the workspace");
  });

  test("web-fetch.ts blocks loopback/link-local/RFC 1918 unless HZ_ALLOW_PRIVATE_FETCH=1", () => {
    const prev = process.env.HZ_ALLOW_PRIVATE_FETCH;
    delete process.env.HZ_ALLOW_PRIVATE_FETCH;
    try {
      for (const bad of [
        "https://localhost/api",
        "https://sub.localhost/api",
        "https://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data/",
        "https://10.0.0.1/internal",
        "https://172.16.5.4/internal",
        "https://192.168.1.1/router",
        "https://[::1]/",
        "https://[fe80::1]/",
        "https://[::ffff:127.0.0.1]/",
      ]) {
        expect(normalizeUrl(bad)).toBeUndefined();
      }
      expect(isBlockedPrivateHost("example.com")).toBe(false);
      expect(normalizeUrl("https://example.com/docs")).toBe("https://example.com/docs");

      process.env.HZ_ALLOW_PRIVATE_FETCH = "1";
      expect(normalizeUrl("https://127.0.0.1/health")).toBe("https://127.0.0.1/health");
    } finally {
      if (prev === undefined) delete process.env.HZ_ALLOW_PRIVATE_FETCH;
      else process.env.HZ_ALLOW_PRIVATE_FETCH = prev;
    }
  });

  test("web-search.ts exports resetWebSearchTurnBudget() that resets turnQueryCount without wiping cache", async () => {
    const prev = process.env.HZ_WEB_SEARCH;
    process.env.HZ_WEB_SEARCH = "1";
    __setWebSearchHttpForTests(async () => new Response('<a class="result__a" href="https://example.com/1">One</a>', { status: 200 }));
    try {
      const ws = makeWorkspace({});
      const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });
      const res = await webSearchTool.execute({ query: "horizoncode track5" }, ctx);
      expect(res.ok).toBe(true);
      expect(getWebSearchBudgetStats().turnQueryCount).toBe(1);
      expect(getWebSearchBudgetStats().cachedEntries).toBe(1);

      resetWebSearchTurnBudget();
      expect(getWebSearchBudgetStats().turnQueryCount).toBe(0);
      expect(getWebSearchBudgetStats().cachedEntries).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.HZ_WEB_SEARCH;
      else process.env.HZ_WEB_SEARCH = prev;
    }
  });
});

describe("Track 5 P1/P2: scripts/refresh-models-snapshot.ts, main.ts, grow.ts", () => {
  test("buildCandidateUrls appends FALLBACK_URLS only for DEFAULT_CATALOG_SOURCE", () => {
    const defaultUrls = buildCandidateUrls({});
    expect(defaultUrls.some((u) => u.includes("models.dev/api.json"))).toBe(true);

    const customUrls = buildCandidateUrls({ HZ_MODELS_URL: "https://internal.corp.example/catalog" });
    expect(customUrls.every((u) => u.startsWith("https://internal.corp.example/catalog"))).toBe(true);
    expect(customUrls.some((u) => u.includes("models.dev"))).toBe(false);
  });

  test("fetchValidatedCatalog validates JSON and MINIMUM_PROVIDERS inside the candidate loop", async () => {
    const validProviders: Record<string, unknown> = {};
    for (let i = 0; i < 105; i++) {
      validProviders[`prov-${i}`] = {
        id: `prov-${i}`,
        name: `Provider ${i}`,
        protocol: "openai-chat",
        baseUrl: `https://prov-${i}.example.test/v1`,
        env: [`PROV_${i}_API_KEY`],
        models: {
          [`m-${i}`]: {
            id: `m-${i}`,
            limit: { context: 65536, output: 8192 },
            capabilities: { tools: { supported: true } },
          },
        },
      };
    }
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("not json at all", { status: 200 });
      if (calls === 2) return new Response(JSON.stringify({ onlyOne: { id: "onlyOne", models: {} } }), { status: 200 });
      return new Response(JSON.stringify(validProviders), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchValidatedCatalog({}, fakeFetch);
    expect(calls).toBe(3);
    expect(Object.keys(result.decoded.providers).length).toBe(105);
  });

  test("writeSnapshotAtomic writes target cleanly with no leftover temp file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-track5-snap-"));
    const target = path.join(dir, "snapshot.json");
    writeSnapshotAtomic(target, '{"ok":true}');
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
    const entries = require("node:fs").readdirSync(dir) as string[];
    expect(entries).toEqual(["snapshot.json"]);
  });

  test("main.ts and grow.ts include Track 5 hardening fixes", () => {
    const mainSrc = readFileSync(path.join(import.meta.dir, "../../src/main.ts"), "utf8");
    expect(mainSrc).toContain('key === "fullscreen-experimental"');
    expect(mainSrc).toContain('let buffer = "";');
    expect(mainSrc).toContain('const acpWorkspace = path.resolve(acpOpts.workspace);');
    expect(mainSrc).toContain('arg === "--worktree" || arg === "--workspace"');
    expect(mainSrc).toContain('new URL(url).origin !== expectedOrigin');
    expect(mainSrc).toContain('await kernel.close().catch(() => undefined);');

    const growSrc = readFileSync(path.join(import.meta.dir, "../../src/grow.ts"), "utf8");
    expect(growSrc).toContain("await kernel.close().catch(() => undefined);");
  });
});

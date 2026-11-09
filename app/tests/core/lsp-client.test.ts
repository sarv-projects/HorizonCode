/**
 * lsp-client.test.ts — the LSP client, mux, writethrough and the `lsp` tool.
 *
 * The fixture behind every spawn is tests/fixtures/fake-lsp-server.ts: a real
 * child speaking Content-Length framed JSON-RPC 2.0. Nothing is mocked — the
 * tests check what the server actually synced (version-stamped publishes), what
 * the guard was asked (the `spawn` admission, before any process exists), and
 * which processes exist afterwards (the spawn ledger and pid liveness).
 *
 * What this suite pins:
 *  (1) the handshake, and didOpen/didChange/didSave reaching the server with a
 *      version-matching publish observed;
 *  (2) version freshness — a diagnostics wait returns the publish whose version
 *      equals the post-change document version, not a stale earlier one;
 *  (3) fresh-only de-charge end to end — a second pass over unchanged content
 *      returns no NEW messages through the ledger while the first returned them;
 *  (4) guarded spawn — the `spawn` GuardAction (kind:'spawn', target
 *      `lsp <id> <digest16>`) is asked BEFORE the child exists; a deny prevents
 *      any spawn (ledger/pid prove it), an ask routes to approve;
 *  (5) graceful degrade — no configured server is a no-op success; a
 *      configured-but-failing handshake degrades to a typed unavailable, never
 *      a throw to the tool;
 *  (6) shutdownAll reaps the child (pid liveness), not merely detaches.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import type {
  ApprovalRequest,
  GuardAction,
  GuardDecision,
  ReceiptInput,
  ToolContext,
} from "../../src/contracts";
import { canonicalJson, sha256Hex } from "../../src/core/canon";
import type { LspConfig, LspServerConfig } from "../../src/core/config";
import { DiagnosticsLedger } from "../../src/core/diagnostics-ledger";
import {
  LspClient,
  lspPids,
  lspSpawnAction,
  pathToFileUri,
  shutdownAll,
  workspaceDiagnostics,
  type LspGuardHooks,
} from "../../src/core/lsp";
import { kernelStateDir, readSpawnLedger } from "../../src/core/owned-spawn";
import { clearLspLedgers, lspTool, setLspConfigOverride } from "../../src/tools/lsp";
import { cleanupTemps, tempDir } from "./helpers";

const BUN = process.execPath || "bun";
const FIXTURE = path.resolve(import.meta.dir, "../fixtures/fake-lsp-server.ts");

/** A config whose one server handles `.ts` by spawning the fake fixture. */
function fixtureConfig(env?: Record<string, string>): LspConfig {
  const server: LspServerConfig = { id: "fake", command: BUN, args: ["run", FIXTURE], extensions: ["ts"] };
  if (env !== undefined) server.env = env;
  return { servers: [server], rejected: [] };
}

interface Calls {
  guards: GuardAction[];
  approvals: ApprovalRequest[];
}

function recordingHooks(opts: { decision?: GuardDecision; approve?: boolean } = {}): { hooks: LspGuardHooks; calls: Calls; notices: string[] } {
  const calls: Calls = { guards: [], approvals: [] };
  const notices: string[] = [];
  return {
    calls,
    notices,
    hooks: {
      guard: async (action) => {
        calls.guards.push(action);
        return opts.decision ?? { decision: "allow" };
      },
      approve: async (req) => {
        calls.approvals.push(req);
        return opts.approve ?? false;
      },
      onNotice: (message) => notices.push(message),
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await shutdownAll();
  clearLspLedgers();
  setLspConfigOverride(null);
});

afterAll(() => {
  cleanupTemps();
});

/* -------------------------------- the client -------------------------------- */

describe("lsp client (stdio transport)", () => {
  test("lspSpawnAction digests command+args only, mirroring the mcp admission shape", () => {
    const server: LspServerConfig = { id: "fake", command: BUN, args: ["run", FIXTURE], extensions: ["ts"] };
    const expected = `lsp fake ${sha256Hex(canonicalJson({ command: BUN, args: ["run", FIXTURE] })).slice(0, 16)}`;
    expect(lspSpawnAction(server)).toEqual({ kind: "spawn", target: expected });
    // env is deliberately NOT part of the digest: a configured secret must not
    // enter the approval target. Adding env changes nothing.
    expect(lspSpawnAction({ ...server, env: { SECRET_TOKEN: "x" } }).target).toBe(expected);
  });

  test("handshake, didOpen/didChange/didSave reach the server, and a version-matching publish is observed", async () => {
    const workspace = tempDir("hz-lsp-basic-");
    const { hooks } = recordingHooks();
    const client = new LspClient({ server: fixtureConfig().servers[0]!, workspace, cwd: workspace, stateDir: kernelStateDir(workspace), hooks });
    const connected = await client.connect();
    expect(connected).toBe(true);
    expect(client.state).toBe("connected");
    expect(client.pid).toBeGreaterThan(0);

    const uri = pathToFileUri(path.join(workspace, "a.ts"));
    client.didOpen(uri, "typescript", "const x = 1;\n");
    const version = client.didChange(uri, `${"ERRORLINE"}\nconst x = 1;\n`);
    client.didSave(uri);
    expect(version).toBe(2); // didOpen=1, one didChange -> 2

    const diagnostics = await client.waitForDiagnostics(uri, version, 3_000);
    // The sentinel content yields exactly one error diagnostic, stamped v2.
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.severity).toBe(1);
    expect(diagnostics[0]?.message).toContain("sentinel");

    // The spawn went through the one owned path: the ledger names the label.
    const ledger = await readSpawnLedger(kernelStateDir(workspace));
    expect(ledger.corrupt).toBe(false);
    expect(ledger.entries.some((e) => e.pid === client.pid && e.label === "lsp: fake")).toBe(true);
  });

  test("version freshness: the wait returns the publish whose version matches the post-change version, not a stale one", async () => {
    const workspace = tempDir("hz-lsp-fresh-");
    const { hooks } = recordingHooks();
    const client = new LspClient({ server: fixtureConfig().servers[0]!, workspace, cwd: workspace, stateDir: kernelStateDir(workspace), hooks });
    await client.connect();
    const uri = pathToFileUri(path.join(workspace, "b.ts"));

    // Open with sentinel (v1 would publish an error), then change to CLEAN
    // content (v2 publishes none). A wait for v2 must see the CLEAN result, not
    // the stale v1 error.
    client.didOpen(uri, "typescript", "ERRORLINE\n");
    const v2 = client.didChange(uri, "const ok = 1;\n");
    client.didSave(uri);
    expect(v2).toBe(2);
    const fresh = await client.waitForDiagnostics(uri, v2, 3_000);
    expect(fresh).toEqual([]); // the v2 publish is clean; the v1 error is stale

    // And a wait for a version that never publishes times out to empty, never hangs.
    const never = await client.waitForDiagnostics(uri, 99, 150);
    expect(never).toEqual([]);
  });

  test("guarded spawn: the spawn admission is asked BEFORE the child exists; a deny prevents any spawn", async () => {
    const workspace = tempDir("hz-lsp-deny-");
    const { hooks, calls } = recordingHooks({ decision: { decision: "deny", reason: "policy denies spawn" } });
    const client = new LspClient({ server: fixtureConfig().servers[0]!, workspace, cwd: workspace, stateDir: kernelStateDir(workspace), hooks });
    const connected = await client.connect();
    expect(connected).toBe(false);
    expect(client.state).toBe("unavailable");
    expect(client.unavailableReason).toBe("denied");
    expect(client.pid).toBeUndefined();

    // The guard saw exactly the spawn admission, naming the exact program.
    expect(calls.guards.length).toBe(1);
    expect(calls.guards[0]).toEqual(lspSpawnAction(fixtureConfig().servers[0]!));
    expect(calls.guards[0]?.kind).toBe("spawn");
    // No process was started at all: the ledger is empty.
    const ledger = await readSpawnLedger(kernelStateDir(workspace));
    expect(ledger.entries).toEqual([]);
  });

  test("guarded spawn: an ask routes to approve; a decline starts nothing, an approval starts the child", async () => {
    const declinedWs = tempDir("hz-lsp-ask-no-");
    const declined = recordingHooks({ decision: { decision: "ask" }, approve: false });
    const declining = new LspClient({ server: fixtureConfig().servers[0]!, workspace: declinedWs, cwd: declinedWs, stateDir: kernelStateDir(declinedWs), hooks: declined.hooks });
    expect(await declining.connect()).toBe(false);
    expect(declined.calls.approvals.length).toBe(1);
    expect(declined.calls.approvals[0]?.title).toContain("fake");
    expect(declining.unavailableReason).toBe("declined");
    expect((await readSpawnLedger(kernelStateDir(declinedWs))).entries).toEqual([]);

    const approvedWs = tempDir("hz-lsp-ask-yes-");
    const approved = recordingHooks({ decision: { decision: "ask" }, approve: true });
    const approving = new LspClient({ server: fixtureConfig().servers[0]!, workspace: approvedWs, cwd: approvedWs, stateDir: kernelStateDir(approvedWs), hooks: approved.hooks });
    expect(await approving.connect()).toBe(true);
    expect(approved.calls.approvals.length).toBe(1);
    expect(approving.pid).toBeGreaterThan(0);
    await approving.stop();
  });

  test("graceful degrade: a failing handshake (die-on-init knob) becomes a typed unavailable, never a throw", async () => {
    const workspace = tempDir("hz-lsp-fail-");
    const { hooks } = recordingHooks();
    const server: LspServerConfig = { id: "fake", command: BUN, args: ["run", FIXTURE], extensions: ["ts"], env: { FAKE_LSP_DIE_ON_INIT: "1" } };
    const client = new LspClient({ server, workspace, cwd: workspace, stateDir: kernelStateDir(workspace), hooks, connectTimeoutMs: 2_000 });
    const connected = await client.connect();
    expect(connected).toBe(false);
    expect(client.state).toBe("unavailable");
    expect(client.unavailableReason).toBe("handshake-failed");
    // The child was reaped: no live pid is left behind.
    expect(client.pid).toBeUndefined();
  });

  test("shutdownAll reaps the children started through the mux, not merely detaches them", async () => {
    const workspace = tempDir("hz-lsp-reap-");
    const { hooks } = recordingHooks();
    const ledger = new DiagnosticsLedger();
    const result = await workspaceDiagnostics({
      absPath: path.join(workspace, "c.ts"),
      content: "const ok = 1;\n",
      config: fixtureConfig(),
      ledger,
      workspace,
      cwd: workspace,
      hooks,
      waitMs: 1_500,
    });
    expect(result).toBeDefined();
    const pids = lspPids();
    expect(pids.length).toBe(1);
    expect(alive(pids[0]!)).toBe(true);
    await shutdownAll();
    await waitFor(() => !alive(pids[0]!), "the lsp child to be reaped");
    expect(lspPids()).toEqual([]);
  });
});

/* ---------------------------- the writethrough ---------------------------- */

describe("lsp writethrough (version freshness + ledger de-charge)", () => {
  test("fresh-only de-charge: the first pass reports the error, a second pass over unchanged content reports nothing new", async () => {
    const workspace = tempDir("hz-lsp-decharge-");
    const { hooks } = recordingHooks();
    const ledger = new DiagnosticsLedger();
    const absPath = path.join(workspace, "d.ts");
    const content = "ERRORLINE\nconst x = 1;\n";

    const first = await workspaceDiagnostics({ absPath, content, config: fixtureConfig(), ledger, workspace, cwd: workspace, hooks, waitMs: 2_000 });
    expect(first).toBeDefined();
    expect(first!.messages.length).toBe(1);
    expect(first!.errored).toBe(true);
    expect(first!.messages[0]).toMatch(/d\.ts:1:1 error /); // relPath:line:col severity ...
    expect(first!.server).toBe("fake");

    // Second pass, SAME content: the server re-publishes the same diagnostic,
    // but the ledger has already seen its identity -> nothing fresh.
    const second = await workspaceDiagnostics({ absPath, content, config: fixtureConfig(), ledger, workspace, cwd: workspace, hooks, waitMs: 2_000 });
    expect(second).toBeDefined();
    expect(second!.messages).toEqual([]);
    expect(second!.summary).toBe("no issues");
  });

  test("the created-path reload barrier runs ONLY when the server advertises typescript.tsserverRequest", async () => {
    // With the executeCommand advertised, a created-path pass still succeeds and
    // surfaces diagnostics (the barrier is a no-op to the result, proving it did
    // not sink the pass). Without it, the branch is skipped entirely.
    const workspace = tempDir("hz-lsp-reload-");
    const { hooks } = recordingHooks();
    const ledger = new DiagnosticsLedger();
    const config = fixtureConfig({ FAKE_LSP_EXECUTE_COMMAND: "1" });
    const result = await workspaceDiagnostics({
      absPath: path.join(workspace, "e.ts"),
      content: "ERRORLINE\n",
      created: true,
      config,
      ledger,
      workspace,
      cwd: workspace,
      hooks,
      waitMs: 2_000,
    });
    expect(result).toBeDefined();
    expect(result!.errored).toBe(true);
  });

  test("a publish delayed past the inline budget returns `no issues` rather than blocking", async () => {
    const workspace = tempDir("hz-lsp-slow-");
    const { hooks } = recordingHooks();
    const ledger = new DiagnosticsLedger();
    const config = fixtureConfig({ FAKE_LSP_PUBLISH_DELAY_MS: "800" });
    const started = Date.now();
    const result = await workspaceDiagnostics({
      absPath: path.join(workspace, "f.ts"),
      content: "ERRORLINE\n",
      config,
      ledger,
      workspace,
      cwd: workspace,
      hooks,
      waitMs: 150, // budget shorter than the publish delay
    });
    const elapsed = Date.now() - started;
    expect(result).toBeDefined();
    expect(result!.messages).toEqual([]);
    expect(result!.summary).toBe("no issues");
    // It returned on the budget, it did not block for the full 800ms delay.
    expect(elapsed).toBeLessThan(700);
  });

  test("no configured server for the file is a no-op: undefined, never a throw", async () => {
    const workspace = tempDir("hz-lsp-noserver-");
    const { hooks } = recordingHooks();
    const ledger = new DiagnosticsLedger();
    const result = await workspaceDiagnostics({
      absPath: path.join(workspace, "g.md"), // no server handles .md
      content: "# hi\n",
      config: fixtureConfig(),
      ledger,
      workspace,
      cwd: workspace,
      hooks,
    });
    expect(result).toBeUndefined();
    expect(lspPids()).toEqual([]); // nothing spawned
  });
});

/* -------------------------------- the tool -------------------------------- */

describe("lsp tool", () => {
  function toolCtx(workspace: string, calls: Calls, receipts: ReceiptInput[]): ToolContext {
    return {
      cwd: workspace,
      workspace,
      sessionId: "s-lsp-tool",
      signal: new AbortController().signal,
      guard: async (action) => {
        calls.guards.push(action);
        return { decision: "allow" };
      },
      approve: async (req) => {
        calls.approvals.push(req);
        return true;
      },
      receipt: async (rec) => {
        receipts.push(rec);
        return {
          ...rec,
          id: "r-1",
          seq: 1,
          ts: "2026-01-01T00:00:00.000Z",
          prevHash: null,
          hash: "0".repeat(64),
        };
      },
    };
  }

  test("diagnostics op surfaces fresh diagnostics in the output and issues an lsp.diagnostics receipt", async () => {
    const workspace = tempDir("hz-lsp-tool-ok-");
    writeFileSync(path.join(workspace, "h.ts"), "ERRORLINE\n");
    setLspConfigOverride(fixtureConfig());
    const calls: Calls = { guards: [], approvals: [] };
    const receipts: ReceiptInput[] = [];
    const result = await lspTool.execute({ op: "diagnostics", path: "h.ts" }, toolCtx(workspace, calls, receipts));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("h.ts (fake):");
    expect(result.output).toContain("error");
    // The spawn admission was asked through the tool's ctx.guard.
    expect(calls.guards.some((g) => g.kind === "spawn" && g.target.startsWith("lsp fake "))).toBe(true);
    // The op issued its own receipt with the documented digests.
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.action).toBe("lsp.diagnostics");
    expect(receipts[0]?.tool).toBe("lsp");
    expect(receipts[0]?.argsDigest).toBe(sha256Hex(canonicalJson({ op: "diagnostics", path: "h.ts" })));
    expect(receipts[0]?.resultDigest).toBe(sha256Hex(result.output));
  });

  test("with no server configured for the file type the tool is a graceful no-op success, never a crash", async () => {
    const workspace = tempDir("hz-lsp-tool-noop-");
    writeFileSync(path.join(workspace, "i.md"), "# doc\n");
    setLspConfigOverride(fixtureConfig()); // handles .ts only
    const calls: Calls = { guards: [], approvals: [] };
    const receipts: ReceiptInput[] = [];
    const result = await lspTool.execute({ op: "diagnostics", path: "i.md" }, toolCtx(workspace, calls, receipts));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no language server configured");
    // No spawn admission at all: nothing matched the extension.
    expect(calls.guards.some((g) => g.kind === "spawn")).toBe(false);
    expect(lspPids()).toEqual([]);
  });

  test("a configured-but-failing server degrades to a no-op success, never a throw to the tool", async () => {
    const workspace = tempDir("hz-lsp-tool-fail-");
    writeFileSync(path.join(workspace, "j.ts"), "ERRORLINE\n");
    setLspConfigOverride(fixtureConfig({ FAKE_LSP_DIE_ON_INIT: "1" }));
    const calls: Calls = { guards: [], approvals: [] };
    const receipts: ReceiptInput[] = [];
    const result = await lspTool.execute({ op: "diagnostics", path: "j.ts" }, toolCtx(workspace, calls, receipts));
    expect(result.ok).toBe(true);
    // The handshake died; the writethrough saw no live client, so no issues.
    expect(result.output).toContain("j.ts: no issues");
  });
});

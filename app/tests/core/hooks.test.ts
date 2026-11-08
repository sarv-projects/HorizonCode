/**
 * hooks.test.ts — hooks v1 (app/src/core/hooks.ts): pre/post tool middleware.
 *
 * The module's contract is a fail-closed one, so these tests are about the
 * POSTURE, not just the happy path:
 *
 *  - an absent config spawns nothing at all (zero cost, zero events);
 *  - a malformed hooks.json denies every call with a typed reason naming the
 *    file and the parse error — a disabled deny-hook must not look like "no
 *    hooks";
 *  - every failure mode of the one-line protocol — missing, garbage and extra
 *    output, non-zero exit, hang, spawn error — denies at the deciding point;
 *  - a failing post hook is a notice, never a throw, and never blocks a later
 *    post hook;
 *  - ordering is declaration order (user file first), the first deny wins, and
 *    a short-circuited hook is never spawned;
 *  - every hook run is a row in the owned-spawn ledger (NF-071).
 *
 * Real processes throughout (fixtures under tests/fixtures/hooks/), a temp HOME
 * and a temp workspace per case, no network. The hook scripts are deliberately
 * dumb: each one exercises one protocol fact and exits; the deny/allow scripts
 * validate the input shape they received, so a plumbing bug fails a test rather
 * than passing quietly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  hooksConfigFiles,
  loadHooks,
  runPostToolHooks,
  runPreToolHooks,
  type HookDef,
  type HookMatch,
  type PostToolHookContext,
} from "../../src/core/hooks";
import { kernelStateDir, readSpawnLedger, spawnLedgerPath } from "../../src/core/owned-spawn";
import { userConfigDir } from "../../src/core/paths";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures/hooks");
const dirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fixtureWorld(prefix: string): { ws: string; home: string } {
  return { ws: scratchDir(`${prefix}-ws-`), home: scratchDir(`${prefix}-home-`) };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function wsHooksFile(ws: string): string {
  return path.join(ws, ".hz", "hooks.json");
}

function writeHooks(file: string, doc: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2), "utf8");
}

const bashHook = (script: string, extra: Partial<HookDef> = {}): HookDef => ({
  command: "bash",
  args: [path.join(FIXTURES, script)],
  ...extra,
});

const jsHook = (script: string, extra: Partial<HookDef> = {}): HookDef => ({
  command: process.execPath,
  args: [path.join(FIXTURES, script)],
  ...extra,
});

/** Appends its label to a workspace-relative log, then allows (order proof). */
const markerHook = (log: string, label: string, match?: HookMatch): HookDef => ({
  command: "bash",
  args: [path.join(FIXTURES, "marker.sh"), log, label],
  ...(match === undefined ? {} : { match }),
});

interface Probe {
  notices: string[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

/** A full call context plus captured notices/events; post defaults are unused by pre tests. */
function context(
  workspace: string,
  tool: string,
  args: Record<string, unknown> = {},
  result: { ok: boolean; ms: number; outputExcerpt: string } = { ok: true, ms: 12, outputExcerpt: "tool output" },
): PostToolHookContext & Probe {
  const notices: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sessionId: "sess-hooks",
    workspace,
    callId: "call-hooks",
    tool,
    args,
    ok: result.ok,
    ms: result.ms,
    outputExcerpt: result.outputExcerpt,
    notices,
    events,
    onNotice: (message) => notices.push(message),
    onEvent: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
  };
}

const ledgerPath = (ws: string): string => spawnLedgerPath(kernelStateDir(ws));

/* ------------------------- discovery and precedence ------------------------- */

describe("loadHooks: config discovery", () => {
  test("no config anywhere is 'none': no hook runs, no process, no ledger", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-absent");
    const config = loadHooks(ws, { home });
    expect(config.state).toBe("none");

    const ctx = context(ws, "write", { path: "a.txt" });
    expect(await runPreToolHooks(config, ctx)).toEqual({ decision: "allow" });
    await runPostToolHooks(config, ctx);
    expect(ctx.notices).toEqual([]);
    expect(ctx.events).toEqual([]);
    expect(existsSync(ledgerPath(ws))).toBe(false);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toEqual([]);
  });

  test("an existing ~/.hzcode tree is honoured in place; the canonical file is not read", () => {
    const { ws, home } = fixtureWorld("hz-hooks-legacy");
    const legacy = path.join(home, ".hzcode", "hooks.json");
    writeHooks(legacy, { hooks: { preTool: [bashHook("allow.sh")] } });
    // This file would win only if the legacy tree were ignored.
    writeHooks(path.join(home, ".config", "horizon", "hooks.json"), { hooks: { preTool: [jsHook("deny-with-reason.js")] } });

    const config = loadHooks(ws, { home });
    expect(config.state).toBe("ready");
    if (config.state !== "ready") return;
    expect(config.sources).toEqual([legacy]);
    expect(config.preTool.map((hook) => hook.source)).toEqual([legacy]);
    expect(hooksConfigFiles(ws, { home })[0]).toBe(legacy);
  });

  test("without a legacy tree the canonical ~/.config/horizon dir is used", () => {
    const { ws, home } = fixtureWorld("hz-hooks-canonical");
    expect(userConfigDir(home)).toBe(path.join(home, ".config", "horizon"));
    const file = path.join(userConfigDir(home), "hooks.json");
    writeHooks(file, { hooks: { preTool: [bashHook("allow.sh")] } });

    const config = loadHooks(ws, { home });
    expect(config.state).toBe("ready");
    if (config.state !== "ready") return;
    expect(config.sources).toEqual([file]);
  });

  test("the workspace file is <ws>/.hz/hooks.json, defaults fill in, and match filters tools", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-ws");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook("allow.sh", { match: { tool: "read" } })] } });

    const config = loadHooks(ws, { home });
    expect(config.state).toBe("ready");
    if (config.state !== "ready") return;
    expect(config.sources).toEqual([wsHooksFile(ws)]);
    expect(config.preTool).toHaveLength(1);
    expect(config.preTool[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(5_000);

    // A non-matching tool advances without spawning anything.
    const skipped = context(ws, "write", { path: "a.txt" });
    expect(await runPreToolHooks(config, skipped)).toEqual({ decision: "allow" });
    expect(existsSync(ledgerPath(ws))).toBe(false);

    // The matching tool runs it: one ledger row, label and argv recorded.
    const matched = context(ws, "read", { path: "a.txt" });
    expect(await runPreToolHooks(config, matched)).toEqual({ decision: "allow" });
    const entries = (await readSpawnLedger(kernelStateDir(ws))).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("hook:preTool:0");
    expect(entries[0].cmd).toContain("allow.sh");
    expect(entries[0].pid).toBeGreaterThan(0);
  });

  test('match.tool "*" matches every tool', async () => {
    const { ws, home } = fixtureWorld("hz-hooks-wild");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook("allow.sh", { match: { tool: ["read", "*"] } })] } });
    const config = loadHooks(ws, { home });
    expect(await runPreToolHooks(config, context(ws, "shell", {}))).toEqual({ decision: "allow" });
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(1);
  });

  test("a present but empty hooks object is 'ready' with no hooks (not 'none')", () => {
    const { ws, home } = fixtureWorld("hz-hooks-empty");
    writeHooks(wsHooksFile(ws), { hooks: {} });
    const config = loadHooks(ws, { home });
    expect(config.state).toBe("ready");
    if (config.state !== "ready") return;
    expect(config.preTool).toEqual([]);
    expect(config.postTool).toEqual([]);
    expect(config.sources).toEqual([wsHooksFile(ws)]);
  });
});

/* --------------------------- malformed config --------------------------- */

describe("loadHooks: a malformed config is a typed refusal", () => {
  test("the refusal names the file and the offending piece", () => {
    const { ws, home } = fixtureWorld("hz-hooks-bad");
    const file = wsHooksFile(ws);
    const cases: Array<{ doc: unknown; expectError: string }> = [
      { doc: "{ nope", expectError: "not valid JSON" },
      { doc: "", expectError: "not valid JSON" },
      { doc: { pre: [] }, expectError: 'unknown key "pre"' },
      { doc: { hooks: { beforeTool: [] } }, expectError: 'unknown key hooks."beforeTool"' },
      { doc: { hooks: { preTool: { command: "x" } } }, expectError: "preTool must be an array" },
      { doc: { hooks: { preTool: ["x"] } }, expectError: "preTool[0] must be an object" },
      { doc: { hooks: { preTool: [{ command: "" }] } }, expectError: "command must be a non-empty string" },
      { doc: { hooks: { preTool: [{ command: "x", note: "hi" }] } }, expectError: 'unknown key "note"' },
      { doc: { hooks: { preTool: [{ command: "x", timeoutMs: "5s" }] } }, expectError: "timeoutMs must be an integer" },
      { doc: { hooks: { preTool: [{ command: "x", timeoutMs: 300001 }] } }, expectError: "timeoutMs must be an integer" },
      { doc: { hooks: { preTool: [{ command: "x", args: [1] }] } }, expectError: "args must be an array" },
      { doc: { hooks: { preTool: [{ command: "x", match: { tool: [] } }] } }, expectError: "empty list" },
      { doc: { hooks: { preTool: [{ command: "x", match: { tool: "read", cap: "terminal.run" } }] } }, expectError: 'unknown key "cap"' },
    ];
    for (const { doc, expectError } of cases) {
      writeHooks(file, doc);
      const config = loadHooks(ws, { home });
      expect(config.state, JSON.stringify(doc)).toBe("refused");
      if (config.state !== "refused") continue;
      expect(config.refusals, JSON.stringify(doc)).toHaveLength(1);
      expect(config.refusals[0].file, JSON.stringify(doc)).toBe(file);
      expect(config.refusals[0].error, JSON.stringify(doc)).toContain(expectError);
    }
  });

  test("a malformed file denies every pre call with the typed reason, before any spawn", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-refuse");
    writeHooks(path.join(home, ".config", "horizon", "hooks.json"), { hooks: { preTool: [bashHook("allow.sh")] } });
    writeHooks(wsHooksFile(ws), "{ nope");
    const config = loadHooks(ws, { home });
    expect(config.state).toBe("refused");

    const ctx = context(ws, "write", { path: "a.txt" });
    const decision = await runPreToolHooks(config, ctx);
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toContain("HZ_PRECONDITION_FAILED");
    expect(decision.reason).toContain(wsHooksFile(ws));
    expect(decision.reason).toContain("not valid JSON");
    expect(ctx.events).toEqual([
      {
        type: "hook.decision",
        payload: { tool: "write", hook: wsHooksFile(ws), decision: "deny", reason: decision.reason },
      },
    ]);

    // The refusal is decided before any process exists.
    expect(existsSync(ledgerPath(ws))).toBe(false);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toEqual([]);

    // A refused config is inert for post hooks: its posture already denied the call.
    const post = context(ws, "write", {});
    await runPostToolHooks(config, post);
    expect(post.notices).toEqual([]);
    expect(post.events).toEqual([]);
  });

  test("a malformed user file refuses just the same, even when the workspace file is valid", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-refuse-user");
    const userFile = path.join(home, ".config", "horizon", "hooks.json");
    writeHooks(userFile, "{ not json");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook("allow.sh")] } });

    const config = loadHooks(ws, { home });
    expect(config.state).toBe("refused");
    if (config.state !== "refused") return;
    expect(config.refusals[0].file).toBe(userFile);
    const decision = await runPreToolHooks(config, context(ws, "read", {}));
    expect(decision.decision).toBe("deny");
  });
});

/* --------------------------- the process protocol --------------------------- */

describe("runPreToolHooks: the one-line protocol", () => {
  test("an allow hook runs, is recorded in the ledger, and advances", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-allow");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook("allow.sh")] } });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "read", { path: "note.txt" });
    expect(await runPreToolHooks(config, ctx)).toEqual({ decision: "allow" });
    expect(ctx.notices).toEqual([]);
    expect(ctx.events).toEqual([
      { type: "hook.decision", payload: { tool: "read", hook: "bash (preTool[0])", decision: "allow" } },
    ]);

    const entries = (await readSpawnLedger(kernelStateDir(ws))).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("hook:preTool:0");
    expect(entries[0].cmd).toContain("allow.sh");
    expect(entries[0].pid).toBeGreaterThan(0);
  });

  test("a deny hook sees the declared input and its reason is carried verbatim", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-deny");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [jsHook("deny-with-reason.js")] } });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "write", { path: "blocked.txt" });
    const decision = await runPreToolHooks(config, ctx);
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toContain("hook_denied");
    expect(decision.reason).toContain("fixture says no: write on blocked.txt");

    const last = ctx.events[ctx.events.length - 1];
    expect(last.type).toBe("hook.decision");
    expect(last.payload.tool).toBe("write");
    expect(last.payload.decision).toBe("deny");
    expect(last.payload.reason).toBe(decision.reason);
    expect(String(last.payload.hook)).toContain("preTool[0]");
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(1);
  });

  test("missing, garbage and extra output all deny as hook failures", async () => {
    const cases: Array<{ script: string; expected: string }> = [
      { script: "silent.sh", expected: "wrote no output" },
      { script: "garbage-output.sh", expected: "stdout is not valid JSON" },
      { script: "extra-output.sh", expected: "wrote 2 lines" },
    ];
    for (const { script, expected } of cases) {
      const { ws, home } = fixtureWorld("hz-hooks-proto");
      writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook(script)] } });
      const config = loadHooks(ws, { home });
      const ctx = context(ws, "read", {});
      const decision = await runPreToolHooks(config, ctx);
      expect(decision.decision, script).toBe("deny");
      if (decision.decision !== "deny") continue;
      expect(decision.reason, script).toContain("hook_denied");
      expect(decision.reason, script).toContain(expected);
      expect(ctx.events.some((event) => event.type === "hook.failure"), script).toBe(true);
    }
  });

  test("a non-zero exit denies even after a valid allow line", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-exit");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [bashHook("exit-code-3.sh")] } });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "read", {});
    const decision = await runPreToolHooks(config, ctx);
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toContain("hook_denied");
    expect(decision.reason).toContain("exited with code 3");
    const failure = ctx.events.find((event) => event.type === "hook.failure");
    expect(failure?.payload.error).toContain("exited with code 3");
  });

  test("a hang is denied at its configured timeout and the child is killed", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-hang");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [jsHook("hang.js", { timeoutMs: 200 })] } });
    const config = loadHooks(ws, { home });

    const started = Date.now();
    const decision = await runPreToolHooks(config, context(ws, "read", {}));
    const elapsed = Date.now() - started;
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toContain("timed out after 200ms");
    // The fixture sleeps 60 s; only a real kill lets this return.
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(5_000);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(1);
  });

  test("a slow hook inside its configured timeout still allows", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-slow");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [jsHook("slow-ok.js", { timeoutMs: 3_000 })] } });
    const config = loadHooks(ws, { home });

    const started = Date.now();
    expect(await runPreToolHooks(config, context(ws, "read", {}))).toEqual({ decision: "allow" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
  });

  test("a spawn failure denies and names the command", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-nospawn");
    const missing = path.join(ws, "no-such-hook-program");
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [{ command: missing, args: [] }] } });
    const config = loadHooks(ws, { home });

    const decision = await runPreToolHooks(config, context(ws, "read", {}));
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toContain("hook_denied");
    expect(decision.reason).toContain(missing);
  });
});

/* --------------------------- ordering and short-circuit --------------------------- */

describe("runPreToolHooks: ordering and short-circuit", () => {
  test("hooks run in declaration order and an allow advances to the next", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-order");
    writeHooks(wsHooksFile(ws), {
      hooks: { preTool: [markerHook("order.log", "first"), markerHook("order.log", "second")] },
    });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "read", {});
    expect(await runPreToolHooks(config, ctx)).toEqual({ decision: "allow" });
    expect(readFileSync(path.join(ws, "order.log"), "utf8").split("\n").filter(Boolean)).toEqual(["first", "second"]);
    expect(ctx.events.map((event) => event.payload.decision)).toEqual(["allow", "allow"]);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(2);
  });

  test("the first deny wins and later hooks are never spawned", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-shortcircuit");
    writeHooks(wsHooksFile(ws), {
      hooks: { preTool: [jsHook("deny-with-reason.js"), markerHook("never.log", "later")] },
    });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "write", { path: "x.txt" });
    const decision = await runPreToolHooks(config, ctx);
    expect(decision.decision).toBe("deny");
    expect(existsSync(path.join(ws, "never.log"))).toBe(false);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(1);
    expect(ctx.events).toHaveLength(1);
  });

  test("a deny after an allow still wins", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-deny-late");
    writeHooks(wsHooksFile(ws), {
      hooks: { preTool: [markerHook("ran.log", "first"), jsHook("deny-with-reason.js")] },
    });
    const config = loadHooks(ws, { home });

    const decision = await runPreToolHooks(config, context(ws, "write", { path: "x.txt" }));
    expect(decision.decision).toBe("deny");
    expect(readFileSync(path.join(ws, "ran.log"), "utf8")).toContain("first");
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(2);
  });

  test("the user file's hooks run before the workspace file's", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-merged");
    writeHooks(path.join(home, ".config", "horizon", "hooks.json"), {
      hooks: { preTool: [markerHook("order.log", "user")] },
    });
    writeHooks(wsHooksFile(ws), { hooks: { preTool: [markerHook("order.log", "workspace")] } });
    const config = loadHooks(ws, { home });

    expect(await runPreToolHooks(config, context(ws, "read", {}))).toEqual({ decision: "allow" });
    expect(readFileSync(path.join(ws, "order.log"), "utf8").split("\n").filter(Boolean)).toEqual(["user", "workspace"]);
    const entries = (await readSpawnLedger(kernelStateDir(ws))).entries;
    expect(entries.map((entry) => entry.label)).toEqual(["hook:preTool:0", "hook:preTool:1"]);
  });
});

/* ------------------------------ post hooks ------------------------------ */

describe("runPostToolHooks: observation only", () => {
  test("a post hook sees the result context with a capped excerpt and blocks nothing", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-post-ok");
    writeHooks(wsHooksFile(ws), { hooks: { postTool: [jsHook("post-check.js")] } });
    const config = loadHooks(ws, { home });

    // The 10 000-char excerpt must arrive capped at 4 096 (the fixture fails
    // otherwise, which would surface as a notice); a failure would also show up
    // in a wrong-shape context, because the fixture validates every field.
    const ctx = context(ws, "read", { path: "note.txt" }, { ok: false, ms: 1234, outputExcerpt: "x".repeat(10_000) });
    await runPostToolHooks(config, ctx);
    expect(ctx.notices).toEqual([]);
    expect(ctx.events).toEqual([]);
    const entries = (await readSpawnLedger(kernelStateDir(ws))).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("hook:postTool:0");
  });

  test("a failing post hook is a notice, never a throw, and later hooks still run", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-post-fail");
    writeHooks(wsHooksFile(ws), {
      hooks: { postTool: [bashHook("garbage-output.sh"), markerHook("post.log", "after-failure")] },
    });
    const config = loadHooks(ws, { home });

    const ctx = context(ws, "write", { path: "a.txt" }, { ok: false, ms: 5, outputExcerpt: "boom" });
    await runPostToolHooks(config, ctx); // must resolve, never reject
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toContain("hook_failed");
    expect(ctx.notices[0]).toContain("postTool[0]");
    expect(ctx.notices[0]).toContain("stdout is not valid JSON");
    expect(ctx.notices[0]).toContain("the tool result is unchanged");
    expect(ctx.events.some((event) => event.type === "hook.failure")).toBe(true);

    // Observation failures do not short-circuit: the next hook still ran.
    expect(readFileSync(path.join(ws, "post.log"), "utf8")).toContain("after-failure");
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toHaveLength(2);
  });

  test("post hooks match their own tools", async () => {
    const { ws, home } = fixtureWorld("hz-hooks-post-match");
    writeHooks(wsHooksFile(ws), { hooks: { postTool: [markerHook("never-post.log", "x", { tool: "read" })] } });
    const config = loadHooks(ws, { home });

    await runPostToolHooks(config, context(ws, "write", {}));
    expect(existsSync(path.join(ws, "never-post.log"))).toBe(false);
    expect((await readSpawnLedger(kernelStateDir(ws))).entries).toEqual([]);
  });
});

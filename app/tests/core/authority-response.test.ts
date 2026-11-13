/**
 * authority-response.test.ts — the response wave for the external review's
 * confirmed authority gaps (`docs/audit/triage-external-review-2026-11-07.md`).
 *
 * Coverage:
 *   - protected kernel state: a write aimed at <ws>/.hzcode/kernel/policy.json
 *     is refused in BOTH transports before policy or leases, even when the
 *     policy on disk allows every write; a symlinked target resolves to the
 *     same refusal; an ordinary workspace write stays allowed;
 *   - admission: agent and code_mode have guard mappings (spawn), a tool with
 *     no mapping fails closed, and every registered tool has an admission;
 *   - approval binding: a second write to the same file with different content
 *     asks again (full operation intent, not kind+target).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GuardAction, KernelMode, Provider, ProviderEvent, Tool } from "../../src/contracts";
import { sha256Hex } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { admissionFor, guardActionFor, runTurn, SESSION_STATE_TOOLS, taskHead } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { tools } from "../../src/tools";
import {
  cleanupTemps,
  hasRustKernel,
  restoreEnv,
  rustKernelPath,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
} from "./helpers";

let envBackup: EnvSnapshot;
let missingBinary = "";
const clients: KernelClient[] = [];
const stores: SessionStore[] = [];

beforeAll(() => {
  envBackup = snapshotEnv();
  missingBinary = path.join(tempDir("hz-auth-nowhere-"), "hz-kernel");
});

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const store of stores.splice(0)) store.close();
  restoreEnv(envBackup);
  cleanupTemps();
});

/* ------------------------------ shared bits ------------------------------ */

/** A provider that plays one scripted turn per call. */
function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

/** One model turn: the given tool calls, then stopReason tool_use. */
function calls(...specs: Array<{ name: string; args: Record<string, unknown> }>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  specs.forEach((spec, i) => {
    events.push({ type: "tool_call", id: `call_${i + 1}`, name: spec.name, arguments: JSON.stringify(spec.args) });
  });
  events.push({ type: "done", stopReason: "tool_use" });
  return events;
}

const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

/** Bring up a client in the requested transport, with HZ_KERNEL_BIN pinned. */
async function startClient(mode: "trusted" | "untrusted", workspace: string, stateDir: string): Promise<KernelClient> {
  if (mode === "trusted") setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_STATE_DIR: undefined });
  else setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
  const client = new KernelClient({ workspace, stateDir });
  expect(await client.start()).toBe(mode);
  clients.push(client);
  return client;
}

interface ScriptedRun {
  workspace: string;
  stateDir: string;
  policyPath: string;
  client: KernelClient;
  store: SessionStore;
  approvals: string[];
  seen: GuardAction[];
  toolMessages(name: string): string[];
}

interface RunOptions {
  policyText?: string;
  answer?: (title: string, count: number) => boolean;
  delegate?: LoopDeps["delegate"];
}

/**
 * One scripted turn against a fresh workspace and state dir, with the guard
 * calls and approvals the run observed recorded for assertions.
 */
async function runScripted(
  mode: "trusted" | "untrusted",
  buildTurns: (paths: { workspace: string; stateDir: string; policyPath: string }) => ProviderEvent[][],
  opts: RunOptions = {},
): Promise<ScriptedRun> {
  const workspace = tempDir("hz-auth-ws-");
  const stateDir = path.join(workspace, ".hzcode", "kernel");
  const policyPath = path.join(stateDir, "policy.json");
  if (opts.policyText !== undefined) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(policyPath, opts.policyText, "utf8");
  }

  const turns = buildTurns({ workspace, stateDir, policyPath });
  const client = await startClient(mode, workspace, stateDir);
  const store = new SessionStore(workspace);
  stores.push(store);

  const seen: GuardAction[] = [];
  const originalCheck = client.checkGuard.bind(client);
  client.checkGuard = async (action, scope, leases, sessionId) => {
    seen.push(action);
    return originalCheck(action, scope, leases, sessionId);
  };

  const approvals: string[] = [];
  const sessionId = store.createSession("authority-response").id;
  const deps: LoopDeps = {
    workspace,
    sessionId,
    model: "scripted-1",
    provider: scriptedProvider(turns),
    kernel: client,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve: async (req) => {
      approvals.push(req.title);
      return opts.answer ? opts.answer(req.title, approvals.length) : true;
    },
    delegate: opts.delegate,
  };
  await runTurn(deps, "authority-response scenario");

  return {
    workspace,
    stateDir,
    policyPath,
    client,
    store,
    approvals,
    seen,
    toolMessages: (name: string) =>
      store
        .history(sessionId)
        .filter((m) => m.role === "tool" && m.toolName === name)
        .map((m) => m.content),
  };
}

/** A policy that allows everything, everywhere — the state-dir rule must still fire. */
const PERMISSIVE = JSON.stringify([
  { kind: "fs.read", scope: "*", decision: "allow" },
  { kind: "fs.write", scope: "*", decision: "allow" },
  { kind: "shell.exec", scope: "*", decision: "allow" },
  { kind: "spawn", scope: "*", decision: "allow" },
]);

/* --------------------------- protected kernel state --------------------------- */

describe("protected kernel state (write tool)", () => {
  for (const mode of ["trusted", "untrusted"] as const) {
    const skip = mode === "trusted" && !hasRustKernel;

    test.skipIf(skip)(
      `${mode}: a write to <state>/policy.json is refused with HZ_PRECONDITION_FAILED and the file is untouched`,
      async () => {
        const run = await runScripted(
          mode,
          ({ policyPath }) => [calls({ name: "write", args: { path: policyPath, content: "[]" } }), DONE],
          { policyText: PERMISSIVE, answer: () => true },
        );

        const messages = run.toolMessages("write");
        expect(messages.length).toBe(1);
        expect(messages[0]).toContain("HZ_PRECONDITION_FAILED");
        expect(messages[0]).toContain("kernel-state-protected");
        expect(readFileSync(run.policyPath, "utf8")).toBe(PERMISSIVE);
        // Refused before policy and before any approval question.
        expect(run.approvals.length).toBe(0);
        expect(run.seen.some((a) => a.kind === "fs.write")).toBe(true);
      },
    );

    test.skipIf(skip)(
      `${mode}: a symlinked target that resolves into the state dir is refused`,
      async () => {
        const run = await runScripted(
          mode,
          ({ workspace, stateDir }) => {
            symlinkSync(stateDir, path.join(workspace, "state-alias"), "dir");
            const target = path.join(workspace, "state-alias", "policy.json");
            return [calls({ name: "write", args: { path: target, content: "[]" } }), DONE];
          },
          { policyText: PERMISSIVE },
        );

        const messages = run.toolMessages("write");
        expect(messages.length).toBe(1);
        expect(messages[0]).toContain("HZ_PRECONDITION_FAILED");
        expect(readFileSync(run.policyPath, "utf8")).toBe(PERMISSIVE);
      },
    );

    test.skipIf(skip)(
      `${mode}: an ordinary workspace write is still allowed and lands`,
      async () => {
        const run = await runScripted(
          mode,
          ({ workspace }) => [
            calls({ name: "write", args: { path: path.join(workspace, "notes.txt"), content: "hello\n" } }),
            DONE,
          ],
          {
            answer: () => {
              throw new Error("a workspace write must not ask for approval");
            },
          },
        );

        expect(readFileSync(path.join(run.workspace, "notes.txt"), "utf8")).toBe("hello\n");
        expect(run.toolMessages("write").length).toBe(1);
        expect(run.approvals.length).toBe(0);
      },
    );
  }
});

/* ------------------------------ admission table ------------------------------ */

describe("every tool passes an admission", () => {
  test("the registry is fully mapped: every tool yields a guard action or session-state", () => {
    const samples: Record<string, Record<string, unknown>> = {
      read: { path: "a.txt" },
      write: { path: "a.txt", content: "x" },
      edit: { path: "a.txt", old: "a", new: "b" },
      grep: { pattern: "needle" },
      glob: { pattern: "*.ts" },
      repo_map: {},
      lint: { path: "a.ts" },
      present: { files: ["a.ts"] },
      shell: { command: "echo hi" },
      todo: { action: "list" },
      undo: {},
      agent: { task: "do it" },
      code_mode: { code: "return 1" },
      preview: { action: "start", command: "true" },
      apply_patch: { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch\n" },
      shell_session: { mode: "start", command: "echo hi" },
      lsp: { op: "diagnostics", path: "a.ts" },
      debug: { op: "stack", command: "fake-dap" },
      memory_search: { query: "rg" },
      handoff_create: { summary: "saved context for next session" },
      handoff_resume: {},
      handoff_search: { query: "blocker" },
      tool_search: { query: "preview dev server" },
      ast_search: { pat: "foo($A)" },
      ast_edit: { path: "a.ts", pat: "foo($A)", out: "bar($A)" },
    };
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(Object.prototype.hasOwnProperty.call(samples, tool.name), `sample args for ${tool.name}`).toBe(true);
      const admission = admissionFor(tool.name, samples[tool.name] as Record<string, unknown>, "/ws");
      expect(admission, tool.name).toBeDefined();
    }
    // The in-process mirror covers session-state tools; an unknown name is refused.
    expect(SESSION_STATE_TOOLS).toContain("todo");
    expect(admissionFor("present", { files: ["a.ts"] }, "/ws")).toEqual({ kind: "session-state" });
    expect(admissionFor("lint", { path: "a.ts" }, "/ws")).toEqual({
      kind: "guard", action: { kind: "fs.read", target: "/ws/a.ts" },
    });
    expect(admissionFor("not-a-tool", {}, "/ws")).toBeUndefined();
  });

  test("the agent call is admitted as spawn and the approval names the task", async () => {
    const task = "summarise the kernel guard code path";
    const run = await runScripted(
      "untrusted",
      () => [calls({ name: "agent", args: { task } }), DONE],
      { delegate: async (given) => ({ ok: true, output: `delegated ${given}` }) },
    );

    expect(run.approvals.length).toBe(1);
    expect(run.approvals[0]).toContain(task);
    const spawn = run.seen.find((action) => action.kind === "spawn");
    expect(spawn?.target).toBe(task);
    expect(run.toolMessages("agent").length).toBe(1);
  });

  test("the agent target is a <=120-character head of the task", () => {
    const long = "step ".repeat(60);
    const action = guardActionFor("agent", { task: long }, "/ws");
    expect(action?.kind).toBe("spawn");
    expect((action?.target ?? "").length).toBeLessThanOrEqual(120);
    expect(taskHead(long).endsWith("...")).toBe(true);
  });

  test("the code_mode call is admitted as spawn with the program digest (and declined, so nothing spawns)", async () => {
    const code = "return 41 + 1;";
    const run = await runScripted(
      "untrusted",
      () => [calls({ name: "code_mode", args: { code } }), DONE],
      { answer: () => false },
    );

    const expected = `code_mode ${sha256Hex(code).slice(0, 16)}`;
    expect(run.seen.some((action) => action.kind === "spawn" && action.target === expected)).toBe(true);
    const messages = run.toolMessages("code_mode");
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("DECLINED by the user");
  });

  test("a tool with no mapping is refused before execution (fail closed)", async () => {
    let executed = false;
    const mystery: Tool = {
      name: "mystery_tool",
      description: "artificially unmapped",
      parameters: {},
      execute: async () => {
        executed = true;
        return { ok: true, output: "ran" };
      },
    };
    tools.push(mystery);
    try {
      const run = await runScripted("untrusted", () => [calls({ name: "mystery_tool", args: { x: 1 } }), DONE]);
      expect(executed).toBe(false);
      const messages = run.toolMessages("mystery_tool");
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("HZ_PRECONDITION_FAILED");
      expect(messages[0]).toContain("no admission mapping");
    } finally {
      tools.pop();
    }
  });
});

/* ------------------------- approval binding (intent) ------------------------- */

describe("approval binding (full operation intent)", () => {
  test("approve write X (content A); a different write to X asks again and cannot ride the first approval", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "hz-auth-outside-"));
    try {
      const target = path.join(outside, "x.txt");
      const run = await runScripted(
        "untrusted",
        () => [
          calls({ name: "write", args: { path: target, content: "alpha" } }),
          calls({ name: "write", args: { path: target, content: "bravo" } }),
          DONE,
        ],
        // The first write is approved; the second must ask, and is declined.
        { answer: (_title, count) => count === 1 },
      );

      expect(run.approvals.length).toBe(2);
      const writes = run.toolMessages("write");
      expect(writes.length).toBe(2);
      expect(writes[0]).not.toContain("DECLINED");
      expect(writes[1]).toContain("DECLINED");
      // The second write never landed: the approval did not transfer.
      expect(readFileSync(target, "utf8")).toBe("alpha");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the same command in a different cwd asks again: an approval is bound to its cwd", async () => {
    const run = await runScripted(
      "untrusted",
      ({ workspace }) => {
        mkdirSync(path.join(workspace, "cwd-a"), { recursive: true });
        mkdirSync(path.join(workspace, "cwd-b"), { recursive: true });
        return [
          calls({ name: "shell", args: { command: "echo hello", cwd: "cwd-a" } }),
          calls({ name: "shell", args: { command: "echo hello", cwd: "cwd-b" } }),
          DONE,
        ];
      },
      // The first command is approved; the same command in another cwd must ask
      // (this used to ride the cwd=a approval), and is declined here.
      { answer: (_title, count) => count === 1 },
    );

    expect(run.approvals.length).toBe(2);
    const shells = run.toolMessages("shell");
    expect(shells.length).toBe(2);
    expect(shells[1]).toContain("DECLINED by the user");
  });
});

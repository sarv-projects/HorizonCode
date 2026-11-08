/**
 * tools-hardening.test.ts — the wave-12 audit fixes that span tools and core:
 *
 *  - the loop's spill of a MINIMISED shell result holds the ORIGINAL bytes
 *    (the model still sees the minimised view);
 *  - `preview` confines its cwd to the workspace, names cwd + command in the
 *    approval (plus the package.json script body), and its registry is
 *    process-global: S1 starts, S2 sees and stops, close() stops everything.
 *
 * Real subprocesses where the contract is about a process; an in-process
 * scripted provider for the loop path, mirroring tests/core/output-budget.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { DEFAULT_POLICY } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { kernelStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { editTool } from "../../src/tools/edit";
import { previewTool, stopAllPreviews } from "../../src/tools/preview";
import { readTool } from "../../src/tools/read";
import { writeTool } from "../../src/tools/write";
import { mockToolContext, tempRoot } from "./helpers";

const dirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await stopAllPreviews();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/* ------------------- the loop spill keeps the raw bytes ------------------- */

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

function loopDeps(workspace: string, provider: Provider): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("hardening").id,
    model: "gpt-4o-mini",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 5 },
  };
  return { deps, kernel, store };
}

function hzNoiseCommand(): string {
  return `yes $'\\033[31m${"x".repeat(40)}\\033[0m' | head -n 600`;
}

describe("the loop spill of a minimised shell result", () => {
  test("holds the ORIGINAL bytes while the model sees the minimised view", async () => {
    const workspace = scratchDir("hz-hard-spill-");
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call_1", name: "shell", arguments: JSON.stringify({ command: hzNoiseCommand() }) },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end" }],
    ]);
    const { deps, kernel, store } = loopDeps(workspace, provider);
    try {
      await runTurn(deps, "produce a lot of coloured output");
      const content = store
        .history(deps.sessionId)
        .filter((m) => m.role === "tool" && m.toolName === "shell")
        .map((m) => m.content)
        .join("");
      expect(content).toContain("[truncated:");
      expect(content).toContain(".hz/state/spills/");
      expect(content).not.toContain("\u001b[31m"); // the model's view is minimised

      const spillRoot = path.join(workspace, ".hz", "state", "spills");
      const files = readdirSync(spillRoot);
      expect(files.length).toBe(1);
      const spill = readFileSync(path.join(spillRoot, files[0] as string), "utf8");
      expect(spill.length).toBeGreaterThan(16 * 1024);
      expect(spill.startsWith("\u001b[31m")).toBe(true); // the raw bytes, not the minimised text
    } finally {
      await kernel.close();
      store.close();
    }
  }, 20000);
});

/* ------------------------ preview confinement ------------------------ */

describe("preview confinement", () => {
  test("a cwd outside the workspace is refused with a typed error naming both paths", async () => {
    const ws = scratchDir("hz-hard-prev-");
    const outside = tempRoot();
    const ctx = mockToolContext({ cwd: ws, workspace: ws });

    const absolute = await previewTool.execute({ action: "start", command: "sleep 60", cwd: outside }, ctx);
    expect(absolute.ok).toBe(false);
    expect(absolute.error).toContain("HZ_PRECONDITION_FAILED");
    expect(absolute.error).toContain(outside);
    expect(absolute.error).toContain(ws);

    const relative = await previewTool.execute({ action: "start", command: "sleep 60", cwd: "../escape" }, ctx);
    expect(relative.ok).toBe(false);
    expect(relative.error).toContain("HZ_PRECONDITION_FAILED");

    // A symlink out of the workspace is classified by where it lands.
    symlinkSync(outside, path.join(ws, "link"));
    const symlinked = await previewTool.execute({ action: "start", command: "sleep 60", cwd: "link" }, ctx);
    expect(symlinked.ok).toBe(false);
    expect(symlinked.error).toContain("HZ_PRECONDITION_FAILED");
    expect(ctx.guardCalls.length).toBe(0); // refused before any guard or approval
  });

  test("a cwd inside the workspace is accepted and runs", async () => {
    const ws = scratchDir("hz-hard-inside-");
    mkdirSync(path.join(ws, "sub"));
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await previewTool.execute({ action: "start", command: "true", cwd: "sub" }, ctx);
    expect(r.error ?? "").not.toContain("HZ_PRECONDITION_FAILED");
    expect(r.output).toContain("exited"); // it ran (and exited immediately): the cwd was accepted
  });
});

/* ------------------------- preview approvals ------------------------- */

describe("preview approvals", () => {
  test("the approval names the resolved cwd, command and package.json script body", async () => {
    const ws = scratchDir("hz-hard-approve-");
    const body = "echo " + "starting-dev-server ".repeat(20) + "and-serving";
    writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { dev: body } }));
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask", approve: false });
    const r = await previewTool.execute({ action: "start" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("DECLINED");
    expect(ctx.approveCalls.length).toBe(1);
    const request = ctx.approveCalls[0] as { title: string; detail?: string };
    expect(request.title).toMatch(/^start preview: (bun|npm) run dev$/);
    expect(request.detail).toContain(`cwd: ${ws}`);
    expect(request.detail).toContain("command: ");
    expect(request.detail).toContain('package.json script "dev": echo starting-dev-server');
    expect(request.detail).toContain("\u2026"); // the script body is truncated to a sane head
  });

  test("an explicit command's approval names cwd and command too", async () => {
    const ws = scratchDir("hz-hard-explicit-");
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "ask", approve: false });
    const r = await previewTool.execute({ action: "start", command: "sleep 60" }, ctx);
    expect(r.ok).toBe(false);
    expect(ctx.approveCalls[0]?.title).toBe("start preview: sleep 60");
    expect(ctx.approveCalls[0]?.detail).toContain(`cwd: ${ws}`);
    expect(ctx.approveCalls[0]?.detail).toContain("command: sleep 60");
  });
});

/* --------------------- preview lifecycle: process-global --------------------- */

function serverCommand(ws: string): string {
  const file = path.join(ws, "serve.ts");
  writeFileSync(
    file,
    'const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });\nconsole.log("listening at " + String(server.url));\n',
  );
  return `${process.execPath} ${file}`;
}

describe("preview lifecycle is process-global", () => {
  test("S1 starts; S2 sees the pid and stops it by id", async () => {
    const ws = scratchDir("hz-hard-sessions-");
    const command = serverCommand(ws);
    const s1 = mockToolContext({ cwd: ws, workspace: ws, sessionId: "hardening-s1" });
    const s2 = mockToolContext({ cwd: ws, workspace: ws, sessionId: "hardening-s2" });

    const started = await previewTool.execute({ action: "start", command }, s1);
    expect(started.ok).toBe(true);
    const pid = Number(/pid (\d+)/.exec(started.output)?.[1]);
    const id = /id ([0-9a-f]+)\)/.exec(started.output)?.[1] ?? "";
    expect(pid).toBeGreaterThan(0);
    expect(id).not.toBe("");

    const seenFromS2 = await previewTool.execute({ action: "status" }, s2);
    expect(seenFromS2.output).toContain(`pid ${pid}`);

    const stopped = await previewTool.execute({ action: "stop", id }, s2);
    expect(stopped.output).toContain("Stopped preview");
    await sleep(500);
    expect(alive(pid)).toBe(false);
    expect((await previewTool.execute({ action: "status" }, s1)).output).toBe("No previews.");
  }, 20000);

  test("close() stops every live preview", async () => {
    const ws = scratchDir("hz-hard-close-");
    const runtime = await createRuntime({ workspace: ws, mock: true });
    const command = serverCommand(ws);
    const ctx = mockToolContext({ cwd: ws, workspace: ws, sessionId: "hardening-close" });

    const started = await previewTool.execute({ action: "start", command }, ctx);
    expect(started.ok).toBe(true);
    const pid = Number(/pid (\d+)/.exec(started.output)?.[1]);
    expect(alive(pid)).toBe(true);

    await runtime.close();
    await sleep(500);
    expect(alive(pid)).toBe(false);
    expect((await previewTool.execute({ action: "status" }, ctx)).output).toBe("No previews.");
  }, 20000);
});

/* ------------ the bridge's approvals bind to the inner arguments ------------ */

/**
 * End-to-end finding-7 repro, driven through the REAL loop: a provider whose
 * tool calls are a direct `write` and then `code_mode` programs; a real kernel
 * (untrusted fallback) with a policy that asks for every workspace write; the
 * real runner subprocess for the programs. The loop-side half of the fix lives
 * in GuardGate.check (the parent admission rides only for the same kind AND
 * target) and the bridge attaches the canonical digest of the inner arguments.
 *
 * Sequence: (1) the human approves the direct write f.txt = AAAA; (2) a
 * program's tools.call('write', f.txt, BBBB) RE-ASKS — and is declined, so the
 * program sees DECLINED and the file stays AAAA; (3) the same exact inner call
 * is approved, lands (BBBB), and a REPEAT of it in the same program asks
 * nothing again (the digest-keyed approval cache holds for the run).
 */
describe("code_mode cached approvals (finding 7, end to end)", () => {
  test("a direct AAAA approval does not cover the program's BBBB write, which re-asks and then caches", async () => {
    const workspace = scratchDir("hz-hard-e2e-");
    const stateDir = kernelStateDir(workspace);
    mkdirSync(stateDir, { recursive: true });
    // The default policy, with every in-workspace write turned into an ask.
    const rules = DEFAULT_POLICY.map((rule) =>
      rule.kind === "fs.write" && rule.scope === "workspace" ? { ...rule, decision: "ask" as const } : rule,
    );
    writeFileSync(path.join(stateDir, "policy.json"), JSON.stringify({ rules }), "utf8");

    const A = { path: "f.txt", content: "AAAA" };
    const B = { path: "f.txt", content: "BBBB" };
    const callB = `await tools.call("write", ${JSON.stringify(B)})`;
    const declinedProgram = `const r = ${callB}; return { ok: r.ok, output: r.output };`;
    const repeatProgram = `const a = ${callB}; const b = ${callB}; return { a: a.ok, b: b.ok };`;

    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "direct_write", name: "write", arguments: JSON.stringify(A) },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "cm_declined",
          name: "code_mode",
          arguments: JSON.stringify({ code: declinedProgram, timeout_ms: 20000 }),
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "cm_repeat",
          name: "code_mode",
          arguments: JSON.stringify({ code: repeatProgram, timeout_ms: 20000 }),
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end" }],
    ]);

    const { deps, kernel, store } = loopDeps(workspace, provider);
    const events: RuntimeEvent[] = [];
    deps.callbacks = { onEvent: (ev) => events.push(ev) };

    const asks: string[] = [];
    // At the moment of every code_mode inner ask, f.txt must still hold AAAA:
    // the declined attempt never touched it (snapshotted here, asserted after
    // the run — an assertion thrown inside the handler would be swallowed by
    // the gate's fail-closed try/catch and flip the answer to "no").
    const innerSnapshots: string[] = [];
    let innerAsks = 0;
    deps.approve = async (req) => {
      asks.push(req.title);
      if (req.title === "code_mode: write") {
        innerSnapshots.push(readFileSync(path.join(workspace, "f.txt"), "utf8"));
        innerAsks += 1;
        return innerAsks > 1; // decline the first inner ask; approve the exact call after
      }
      return true;
    };

    try {
      const result = await runTurn(deps, "approve AAAA, then run a code_mode program writing BBBB");

      // The run itself was clean: the declined inner call is a normal refusal.
      expect(result.exit.terminal).toBe("succeeded");
      expect(result.exit.detail).toBe("turn_end");

      // The ask sequence proves the re-ask and the cache:
      //  - the direct write asked once ("write f.txt");
      //  - both code_mode spawns asked;
      //  - the FIRST inner BBBB ask (the audit's silent allow) happened and was
      //    declined; the later exact inner call asked once (the bridge's ask)
      //    plus the write tool's own digest-less ask, and the repeat asked none.
      expect(asks.filter((title) => title === "write f.txt")).toHaveLength(1);
      expect(asks.filter((title) => title.startsWith("spawn code_mode"))).toHaveLength(2);
      expect(asks.filter((title) => title === "code_mode: write")).toHaveLength(2);
      expect(asks.filter((title) => title === "Write f.txt")).toHaveLength(1);
      const firstInner = asks.indexOf("code_mode: write");
      const secondInner = asks.lastIndexOf("code_mode: write");
      expect(firstInner).toBeGreaterThan(asks.indexOf("write f.txt"));
      expect(secondInner).toBeGreaterThan(firstInner);
      // The repeat added no ask at all: the write tool's own ask is the last one.
      expect(asks[asks.length - 1]).toBe("Write f.txt");

      // At every inner ask the file still held AAAA — the declined write never landed.
      expect(innerSnapshots).toEqual(["AAAA", "AAAA"]);

      // The declined program was told so; the repeat program's calls both landed.
      const programResults = store
        .history(deps.sessionId)
        .filter((m) => m.role === "tool" && m.toolName === "code_mode")
        .map((m) => m.content);
      expect(programResults).toHaveLength(2);
      expect(programResults[0]).toContain("DECLINED by the user");
      expect(programResults[0]).toContain('"ok":false');
      expect(programResults[1]).toContain('"a":true');
      expect(programResults[1]).toContain('"b":true');

      // The final content is the approved write; the declined one never landed.
      expect(readFileSync(path.join(workspace, "f.txt"), "utf8")).toBe("BBBB");

      // Receipts verify: the direct write, both code_mode calls and the two
      // successful inner writes each left one (the declined call left none).
      const receipts = await kernel.verifyReceipts();
      expect(receipts.ok).toBe(true);
      expect(receipts.count).toBe(5);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 60000);
});

/* ---------------- effect-time path verification (finding 10) ---------------- */

function stateDirOf(ws: string): string {
  const dir = kernelStateDir(ws);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("write verifies where the effect lands, not where the path pointed", () => {
  test("a racer's swap to a symlink into the kernel state dir is refused every time; the state file is byte-unchanged", async () => {
    const ws = scratchDir("hz-hard-wrace-");
    const stateDir = stateDirOf(ws);
    const policy = path.join(stateDir, "policy.json");
    const policyBytes = '{"rules":[]}\n';
    writeFileSync(policy, policyBytes);
    const requested = path.join(ws, "f.txt");
    const harmless = "harmless original\n";
    writeFileSync(requested, harmless);

    let wrote = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      // The racer flips the path AFTER the guard decision and before the effect.
      const ctx = mockToolContext({
        cwd: ws,
        workspace: ws,
        decision: () => {
          rmSync(requested, { force: true });
          symlinkSync(policy, requested);
          return { decision: "allow" };
        },
      });
      const r = await writeTool.execute({ path: "f.txt", content: `PWNED ${attempt}\n` }, ctx);
      if (r.ok) wrote += 1;
      else {
        expect(r.error).toContain("HZ_PRECONDITION_FAILED");
        expect(r.error).toContain(requested); // names the requested path...
        expect(r.error).toContain(policy); // ...and the resolved one
      }
      expect(readFileSync(policy, "utf8")).toBe(policyBytes);
      rmSync(requested, { force: true });
      writeFileSync(requested, harmless);
    }
    expect(wrote).toBe(0);
  }, 20000);

  test("without a swap the same call writes the requested file", async () => {
    const ws = scratchDir("hz-hard-wnoswap-");
    stateDirOf(ws);
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await writeTool.execute({ path: "f.txt", content: "written\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(ws, "f.txt"), "utf8")).toBe("written\n");
  });

  test("symlink policy: writing THROUGH a file-level symlink to a legitimate target keeps working", async () => {
    const ws = scratchDir("hz-hard-wlink-");
    stateDirOf(ws);
    writeFileSync(path.join(ws, "real.txt"), "real\n");
    symlinkSync(path.join(ws, "real.txt"), path.join(ws, "link.txt"));
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    // Read first: the gate refuses an unread existing target (read-ledger test),
    // and a read through the link marks its realpath.
    expect((await readTool.execute({ path: "link.txt" }, ctx)).ok).toBe(true);
    const r = await writeTool.execute({ path: "link.txt", content: "through the link\n" }, ctx);
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(ws, "real.txt"), "utf8")).toBe("through the link\n");
  });

  test("a symlinked workspace directory does not break writes", async () => {
    const ws = scratchDir("hz-hard-wdir-");
    stateDirOf(ws);
    mkdirSync(path.join(ws, "realdir"));
    symlinkSync(path.join(ws, "realdir"), path.join(ws, "linkdir"));
    const r = await writeTool.execute(
      { path: "linkdir/f.txt", content: "in a linked dir\n" },
      mockToolContext({ cwd: ws, workspace: ws }),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(ws, "realdir", "f.txt"), "utf8")).toBe("in a linked dir\n");
  });
});

describe("edit verifies the effect's path too", () => {
  test("a symlink into the kernel state dir is refused at effect time even when the preimage matches", async () => {
    const ws = scratchDir("hz-hard-erace-");
    const stateDir = stateDirOf(ws);
    const target = path.join(stateDir, "copy.json");
    writeFileSync(target, "AAAA\n");
    // Same content as the file the edit reads, so the preimage check passes:
    // only the descriptor's real target can catch this.
    symlinkSync(target, path.join(ws, "file.txt"));
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await editTool.execute({ path: "file.txt", old: "AAAA", new: "BBBB" }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("HZ_PRECONDITION_FAILED");
    expect(String(r.error)).toContain(target);
    expect(readFileSync(target, "utf8")).toBe("AAAA\n");
  });

  test("a swap during the approval window loses no update: the refusal is typed and nothing is written", async () => {
    const ws = scratchDir("hz-hard-ewindow-");
    const stateDir = stateDirOf(ws);
    const policy = path.join(stateDir, "policy.json");
    writeFileSync(policy, '{"rules":[]}\n');
    const file = path.join(ws, "file.txt");
    writeFileSync(file, "AAAA\n");
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: "ask",
      approve: () => {
        // The racer acts while the human is being asked.
        rmSync(file, { force: true });
        symlinkSync(policy, file);
        return true;
      },
    });
    const r = await editTool.execute({ path: "file.txt", old: "AAAA", new: "BBBB" }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("HZ_PRECONDITION_FAILED");
    expect(readFileSync(policy, "utf8")).toBe('{"rules":[]}\n');
  });
});

/* ------------- a tool result that cannot reach the transcript ------------- */

/**
 * Wave-12: when the tool-result transcript write throws AFTER the tool ran,
 * the tool card used to stay "running", the batch catch emitted only a bare
 * "failed unexpectedly" notice, and the run died with a generic
 * internal_error — while the tool's effect was real. The fix: the card is
 * marked failed with the typed error, a notice names the tool and says the
 * effect already ran, the receipt is still attempted (best-effort — a failure
 * there is noticed too), and the run stops with a run-level failure that names
 * the transcript write instead of the bare form.
 */
describe("a tool-result transcript failure after the effect (wave-12)", () => {
  test("marks the card failed, keeps the effect evidenced and stops the run typed", async () => {
    const workspace = scratchDir("hz-hard-tx-");
    const provider = scriptedProvider([
      [
        {
          type: "tool_call",
          id: "shell_1",
          name: "shell",
          arguments: JSON.stringify({ command: "printf ran > marker.txt" }),
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end" }],
    ]);
    const { deps, kernel, store } = loopDeps(workspace, provider);
    const events: RuntimeEvent[] = [];
    deps.callbacks = { onEvent: (ev) => events.push(ev) };
    // The harness drops the messages table while the shell call waits for its
    // approval — i.e. after the guard ask and before the result is appended.
    let dropped = false;
    deps.approve = async () => {
      if (!dropped) {
        dropped = true;
        store.db.exec("DROP TABLE messages");
      }
      return true;
    };

    const messages = (type: "notice" | "error"): string[] =>
      events.filter((ev) => ev.type === type).map((ev) => ("message" in ev ? ev.message : ""));

    try {
      const result = await runTurn(deps, "run a shell command whose result cannot be stored");

      // The effect really happened...
      expect(readFileSync(path.join(workspace, "marker.txt"), "utf8")).toBe("ran");
      // ...and the run cannot claim success after losing the transcript row.
      expect(dropped).toBe(true);
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("internal_error");

      // The card did not stay "running": running, then failed with the typed error.
      const cards = events.filter((ev) => ev.type === "tool.card" && ev.callId === "shell_1");
      expect(cards.map((card) => (card.type === "tool.card" ? card.status : ""))).toEqual(["running", "error"]);

      // The notice names the tool and says the effect already ran.
      const effectNotices = messages("notice").filter((m) => m.includes("the effect already ran"));
      expect(effectNotices).toHaveLength(1);
      expect(effectNotices[0]).toContain("shell");
      expect(effectNotices[0]).toContain("transcript write failed");

      // The receipt was still attempted and issued (the kernel was healthy):
      // the effect stays evidenced even though the transcript lost it.
      const receiptLines = readFileSync(path.join(kernelStateDir(workspace), "receipts.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "");
      expect(receiptLines).toHaveLength(1);
      expect((JSON.parse(receiptLines[0] as string) as { tool: string }).tool).toBe("shell");

      // The run-level failure names the transcript write — never the bare form.
      const errors = messages("error");
      expect(errors.some((m) => m.includes("transcript write failed") && m.includes("shell"))).toBe(true);
      expect(messages("notice").some((m) => m.includes("failed unexpectedly"))).toBe(false);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 30000);
});

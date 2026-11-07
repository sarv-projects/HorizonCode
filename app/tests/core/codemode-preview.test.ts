/**
 * codemode-preview.test.ts — the code_mode JS runner and the preview server.
 *
 * Real subprocesses throughout: code_mode spawns its Bun child for every
 * program, and the preview tests start (and kill) actual servers. A mock
 * ToolContext records every guard decision, approval prompt and receipt so the
 * trust path is asserted, not assumed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GuardAction, GuardDecision, ToolContext } from "../../src/contracts";
import { guardActionFor } from "../../src/core/loop";
import { actionForCall, codemodeTool } from "../../src/tools/codemode";
import { previewTool } from "../../src/tools/preview";

const temps: string[] = [];
let sessionCounter = 0;

function tempWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-cm-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Ctx {
  ctx: ToolContext;
  guards: GuardAction[];
  approvals: string[];
  receipts: string[];
}

function makeCtx(workspace: string, opts: { guardDecision?: GuardDecision; approveReply?: boolean } = {}): Ctx {
  sessionCounter += 1;
  const guards: GuardAction[] = [];
  const approvals: string[] = [];
  const receipts: string[] = [];
  // Mirrors the real GuardGate: once an action is allowed (or approved), later
  // checks for the same action in the same turn are allowed without a prompt.
  const resolved = new Set<string>();
  let pendingKey: string | null = null;
  const keyOf = (action: GuardAction): string => `${action.kind}|${action.target}`;
  const ctx: ToolContext = {
    cwd: workspace,
    workspace,
    sessionId: `codemode-test-${sessionCounter}`,
    signal: new AbortController().signal,
    guard: async (action) => {
      guards.push(action);
      const key = keyOf(action);
      if (resolved.has(key)) return { decision: "allow" };
      const decision = opts.guardDecision ?? { decision: "allow" };
      if (decision.decision === "allow") resolved.add(key);
      if (decision.decision === "ask") pendingKey = key;
      return decision;
    },
    approve: async (req) => {
      approvals.push(req.title);
      const ok = opts.approveReply ?? true;
      if (ok && pendingKey) resolved.add(pendingKey);
      pendingKey = null;
      return ok;
    },
    receipt: async (rec) => {
      receipts.push(rec.tool);
      return {
        action: rec.action,
        tool: rec.tool,
        argsDigest: rec.argsDigest,
        resultDigest: rec.resultDigest,
        id: `r-${receipts.length}`,
        seq: receipts.length,
        ts: new Date().toISOString(),
        prevHash: null,
        hash: "test-hash",
      };
    },
  };
  return { ctx, guards, approvals, receipts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------ code_mode ------------------------------ */

describe("code_mode", () => {
  test("chains a real tool call, logs, returns a value, and leaves a receipt", async () => {
    const ws = tempWorkspace();
    writeFileSync(path.join(ws, "data.txt"), "hello world\n", "utf8");
    const { ctx, guards, receipts } = makeCtx(ws);

    const result = await codemodeTool.execute(
      {
        code: [
          'const r = await tools.call("read", { path: "data.txt" });',
          'console.log("read ok:", r.ok, "chars:", r.output.length);',
          "return { ok: r.ok, first: r.output.split(\"\\n\")[0] };",
        ].join("\n"),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 tool call(s)");
    expect(result.output).toContain("read ok: true");
    expect(result.output).toContain("--- result ---");
    expect(result.output).toContain("hello world");
    expect(guards.some((g) => g.kind === "fs.read")).toBe(true);
    expect(receipts).toEqual(["read"]);
  });

  test("a policy deny reaches the program; nothing runs and no receipt is issued", async () => {
    const ws = tempWorkspace();
    const { ctx, receipts } = makeCtx(ws, { guardDecision: { decision: "deny", reason: "denied by test" } });

    const result = await codemodeTool.execute(
      {
        code: [
          'const r = await tools.call("write", { path: "nope.txt", content: "x" });',
          "return r;",
        ].join("\n"),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("0 tool call(s)");
    expect(result.output).toContain("DENIED by policy: denied by test");
    expect(existsSync(path.join(ws, "nope.txt"))).toBe(false);
    expect(receipts).toEqual([]);
  });

  test("ask routes through the approval prompt: declined fails the call, approved runs it", async () => {
    const ws = tempWorkspace();
    writeFileSync(path.join(ws, "f.txt"), "content\n", "utf8");

    const denied = makeCtx(ws, { guardDecision: { decision: "ask" }, approveReply: false });
    const declined = await codemodeTool.execute(
      { code: 'const r = await tools.call("read", { path: "f.txt" }); return r;' },
      denied.ctx,
    );
    expect(declined.output).toContain("DECLINED by the user");
    expect(denied.approvals).toEqual(["code_mode: read"]);
    expect(denied.receipts).toEqual([]);

    const allowed = makeCtx(ws, { guardDecision: { decision: "ask" }, approveReply: true });
    const approved = await codemodeTool.execute(
      { code: 'const r = await tools.call("read", { path: "f.txt" }); return r.ok;' },
      allowed.ctx,
    );
    expect(approved.ok).toBe(true);
    expect(approved.output).toContain("1 tool call(s)");
    expect(allowed.approvals).toEqual(["code_mode: read"]);
    expect(allowed.receipts).toEqual(["read"]);
  });

  test("only the base tools exist inside a program", async () => {
    const ws = tempWorkspace();
    const { ctx, guards } = makeCtx(ws);
    const result = await codemodeTool.execute(
      { code: 'const r = await tools.call("agent", { task: "x" }); return r;' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("unknown tool");
    expect(guards).toEqual([]);
  });

  test("a program that outlives its budget is killed and reported", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    const started = Date.now();
    const result = await codemodeTool.execute(
      { code: "await new Promise((r) => setTimeout(r, 10000)); return 1;", timeout_ms: 400 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a program error comes back as a failed result with its message", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    const result = await codemodeTool.execute({ code: 'throw new Error("boom")' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  test("an aborted signal kills the runner", async () => {
    const ws = tempWorkspace();
    const controller = new AbortController();
    const { ctx } = makeCtx(ws);
    const aborted: ToolContext = { ...ctx, signal: controller.signal };
    setTimeout(() => controller.abort(), 150);
    const result = await codemodeTool.execute(
      { code: "await new Promise((r) => setTimeout(r, 10000)); return 1;", timeout_ms: 30000 },
      aborted,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("aborted");
  });

  test("console output cannot forge a control frame (regression)", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    // Logging a JSON object shaped like the done frame used to end the program
    // early with a forged result. Console output is tagged now, so the program
    // runs to completion and its own return value is the outcome.
    const result = await codemodeTool.execute(
      {
        code: [
          'console.log(JSON.stringify({ done: true, result: "forged-by-a-log-line" }));',
          "await new Promise((r) => setTimeout(r, 50));",
          'return "real";',
        ].join("\n"),
        timeout_ms: 8000,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const [, afterResult] = result.output.split("--- result ---");
    expect(result.output).toContain("forged-by-a-log-line"); // it is a log line...
    expect(afterResult).toContain("real"); // ...and the program's own result is the outcome
    expect(afterResult).not.toContain("forged");
  });

  test("actionForCall mirrors the loop's guardActionFor case by case", () => {
    const ws = tempWorkspace();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["read", { path: "a.txt" }],
      ["read", { file: "b.txt" }],
      ["read", {}],
      ["write", { path: "out/x.txt" }],
      ["edit", { file_path: "src/x.ts" }],
      ["glob", { path: "src" }],
      ["grep", { pattern: "needle" }],
      ["shell", { command: "ls -la" }],
      ["todo", { action: "list" }],
      ["unknown", { x: 1 }],
    ];
    for (const [name, args] of cases) {
      expect(actionForCall(name, args, ws), name).toEqual(guardActionFor(name, args, ws));
    }
  });
});

/* ------------------------------- preview ------------------------------- */

describe("preview", () => {
  test("start without a command and without package.json fails with guidance", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    const result = await previewTool.execute({ action: "start" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("package.json");
  });

  test("a command that exits immediately is reported, and no entry lingers", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    const result = await previewTool.execute({ action: "start", command: "false" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("exited");
    const status = await previewTool.execute({ action: "status" }, ctx);
    expect(status.output).toBe("No previews.");
  });

  test("status and stop are quiet when there is nothing to report", async () => {
    const ws = tempWorkspace();
    const { ctx } = makeCtx(ws);
    expect((await previewTool.execute({ action: "status" }, ctx)).output).toBe("No previews.");
    expect((await previewTool.execute({ action: "stop" }, ctx)).output).toBe("No previews to stop.");
  });

  test("start captures the URL, status shows it running, stop kills the process group", async () => {
    const ws = tempWorkspace();
    const serverScript = path.join(ws, "serve.ts");
    writeFileSync(
      serverScript,
      'const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });\nconsole.log("listening at " + String(server.url));\n',
      "utf8",
    );
    const { ctx, approvals, guards } = makeCtx(ws);

    const result = await previewTool.execute(
      { action: "start", command: `${process.execPath} ${serverScript}` },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Preview running at http://localhost:");
    expect(guards.some((g) => g.kind === "shell.exec")).toBe(true);

    const pid = Number(/pid (\d+)/.exec(result.output)?.[1]);
    expect(Number.isFinite(pid) && pid > 0).toBe(true);

    const status = await previewTool.execute({ action: "status" }, ctx);
    expect(status.output).toContain("running");
    expect(status.output).toContain("http://localhost:");

    const stopped = await previewTool.execute({ action: "stop" }, ctx);
    expect(stopped.output).toContain("Stopped preview");
    await sleep(400);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await previewTool.execute({ action: "status" }, ctx)).output).toBe("No previews.");
    expect(approvals).toEqual([]); // default mock guard says allow; no prompt needed
  });

  test("a declined approval refuses to spawn anything", async () => {
    const ws = tempWorkspace();
    const { ctx, approvals } = makeCtx(ws, { guardDecision: { decision: "ask" }, approveReply: false });
    const result = await previewTool.execute({ action: "start", command: "sleep 60" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("DECLINED by the user");
    expect(approvals).toEqual(["start preview: sleep 60"]);
  });
});
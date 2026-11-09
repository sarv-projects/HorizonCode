/** `shell` — exit codes, output capture, timeout kill, env scrub, abort. */

import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { shellTool } from "../../src/tools/shell";
import { makeWorkspace, mockToolContext } from "./helpers";

/** Set env vars for one test, then restore the previous values. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("shell tool", () => {
  test("captures stdout and reports the exit code", async () => {
    const r = await shellTool.execute({ command: "echo hello" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hello\nexit 0");
  });

  test("captures stderr in the same output", async () => {
    const r = await shellTool.execute({ command: "echo boom 1>&2" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("boom");
    expect(r.output.endsWith("exit 0")).toBe(true);
  });

  test("reports a non-zero exit code as a result, not an error", async () => {
    const r = await shellTool.execute({ command: "exit 3" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe("exit 3");
  });

  test("reports a command that writes nothing as just the exit code", async () => {
    const r = await shellTool.execute({ command: "true" }, mockToolContext());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("exit 0");
  });

  test("runs in the workspace by default", async () => {
    const ws = makeWorkspace();
    const r = await shellTool.execute({ command: "pwd" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output.split("\n")[0]).toBe(realpathSync(ws));
  });

  test("honours the cwd argument", async () => {
    const ws = makeWorkspace({ "sub/keep.txt": "x\n" });
    const r = await shellTool.execute({ command: "pwd", cwd: "sub" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output.split("\n")[0]).toBe(realpathSync(path.join(ws, "sub")));
  });

  test("requires a command", async () => {
    const ctx = mockToolContext();
    expect((await shellTool.execute({}, ctx)).error).toBe("command is required");
    expect((await shellTool.execute({ command: "   " }, ctx)).error).toBe("command is required");
    expect(ctx.guardCalls.length).toBe(0);
  });

  test("kills a command that exceeds timeoutMs", async () => {
    const started = Date.now();
    const r = await shellTool.execute({ command: "sleep 5", timeoutMs: 200 }, mockToolContext());
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timed out after 200ms");
    expect(r.output).toContain("[timed out after 200ms]");
    expect(elapsed).toBeLessThan(3000);
  });

  test("kills a compound command that exceeds timeoutMs", async () => {
    const started = Date.now();
    const r = await shellTool.execute({ command: "sleep 5; echo done", timeoutMs: 200 }, mockToolContext());
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timed out after 200ms");
    expect(elapsed).toBeLessThan(3000);
  });

  test("does not wait for a background process that outlives the command", async () => {
    const started = Date.now();
    const r = await shellTool.execute({ command: "sleep 5 & echo started" }, mockToolContext());
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(true);
    expect(r.output).toBe("started\nexit 0");
    expect(elapsed).toBeLessThan(3000);
  });

  test("asks for approval with the command and honours a decline", async () => {
    const ctx = mockToolContext({ decision: "ask", approve: false });
    const r = await shellTool.execute({ command: "echo hi" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("declined by user");
    expect(ctx.guardCalls).toEqual([{ kind: "shell.exec", target: "echo hi" }]);
    expect(ctx.approveCalls.length).toBe(1);
    expect(ctx.approveCalls[0]).toEqual({ title: "Run shell command", detail: "echo hi", kind: "shell.exec" });
  });

  test("runs the command when an ask is approved", async () => {
    const ctx = mockToolContext({ decision: "ask", approve: true });
    const r = await shellTool.execute({ command: "echo approved" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("approved\nexit 0");
    expect(ctx.approveCalls.length).toBe(1);
  });

  test("reports a policy denial without spawning anything", async () => {
    const ctx = mockToolContext({ decision: "deny", decisionReason: "shell is disabled" });
    const r = await shellTool.execute({ command: "echo nope" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("denied by policy: shell is disabled");
    expect(ctx.approveCalls.length).toBe(0);
  });

  test("scrubs credential-like environment variables from the child", async () => {
    const ctx = mockToolContext();
    await withEnv(
      {
        HZ_TEST_TOKEN: "supersecret-token-value",
        HZ_TEST_API_KEY: "secret-api-key-value",
        HZ_TEST_SECRET: "hidden-secret-value",
        HZ_TEST_PASSWORD: "hidden-password-value",
        HZ_TEST_PLAIN: "plain-visible-value",
      },
      async () => {
        expect(process.env.HZ_TEST_TOKEN).toBe("supersecret-token-value");
        const r = await shellTool.execute(
          { command: `printf '%s|%s|%s|%s|%s|' "$HZ_TEST_TOKEN" "$HZ_TEST_API_KEY" "$HZ_TEST_SECRET" "$HZ_TEST_PASSWORD" "$HZ_TEST_PLAIN"; echo end` },
          ctx,
        );
        expect(r.ok).toBe(true);
        expect(r.output).not.toContain("supersecret-token-value");
        expect(r.output).not.toContain("secret-api-key-value");
        expect(r.output).not.toContain("hidden-secret-value");
        expect(r.output).not.toContain("hidden-password-value");
        expect(r.output).toBe("||||plain-visible-value|end\nexit 0");
      },
    );
  });

  test("is killed and reported as aborted when the context signal fires", async () => {
    const ctx = mockToolContext();
    const started = Date.now();
    const timer = setTimeout(() => ctx.abort(), 150);
    const r = await shellTool.execute({ command: "sleep 5" }, ctx);
    clearTimeout(timer);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("does not start when the signal is already aborted", async () => {
    const ctx = mockToolContext({ aborted: true });
    const r = await shellTool.execute({ command: "echo hi" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted");
    expect(ctx.guardCalls.length).toBe(0);
  });
});

describe("shell tool: invisible Unicode", () => {
  test("a command with a bidi override or zero-width character is refused before running", async () => {
    for (const ch of ["\u202e", "\u200b", "\u2066", "\ufeff", "\u2028"]) {
      let guarded = 0;
      const ctx = mockToolContext({ decision: () => (guarded++, { decision: "allow" }) });
      const r = await shellTool.execute({ command: `echo a${ch}b` }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("invisible or direction-changing Unicode");
      expect(guarded).toBe(0);
    }
  });
});

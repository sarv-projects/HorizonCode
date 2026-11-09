/**
 * Stage-1 fixes: interactive `hzcode serve` over real pipes, the real kernelMode
 * in server.hello, the /files tool buckets, and an exit on every turn.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Runtime } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { createScriptedProvider } from "../../src/core/providers/scripted";
import { createServer } from "../../src/core/server";
import { tools } from "../../src/tools";
import { describeTools, exitLine } from "../../src/tui/interactive";

const MAIN = path.resolve(import.meta.dir, "../../src/main.ts");
const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("P1: hzcode serve answers each line while stdin stays open", () => {
  test("hello then session.create both reply without closing stdin", async () => {
    const ws = tempDir("hz-s1-serve-");
    const home = tempDir("hz-s1-home-");
    // `cat |` makes the server's stdin a genuine OS pipe, the shape that Bun
    // batches until EOF when read through process.stdin.
    const child = spawn("sh", ["-c", `cat | "$0" run "$1" serve --mock --workspace "$2"`, process.execPath, MAIN, ws], {
      cwd: ws,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const waiters: Array<() => void> = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      for (const w of waiters.splice(0)) w();
    });
    const readReply = (id: number, ms: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply for id ${id} within ${ms}ms (stdin still open)`)), ms);
        const check = (): void => {
          for (const line of buf.split("\n")) {
            if (line.trim() === "") continue;
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj.id === id) {
              clearTimeout(t);
              resolve(obj);
              return;
            }
          }
          waiters.push(check);
        };
        check();
      });
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: "server.hello" }) + "\n");
      const hello = (await readReply(1, 8000)).result as Record<string, unknown>;
      expect(hello.proto).toBeDefined();
      child.stdin.write(JSON.stringify({ id: 2, method: "session.create" }) + "\n");
      const created = (await readReply(2, 15000)).result as Record<string, unknown>;
      expect(typeof created.sessionId).toBe("string");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);
});

describe("P4: server.hello reports a real kernelMode before any session", () => {
  test("untrusted when HZ_KERNEL_BIN points nowhere, trusted when it points at a file", async () => {
    const saved = process.env.HZ_KERNEL_BIN;
    try {
      for (const [bin, want] of [
        ["/nonexistent/hz-kernel", "untrusted"],
        [process.execPath, "trusted"],
      ] as const) {
        process.env.HZ_KERNEL_BIN = bin;
        const lines: string[] = [];
        const server = createServer({
          workspace: tempDir("hz-s1-hello-"),
          input: (async function* () {
            yield JSON.stringify({ id: 1, method: "server.hello" }) + "\n";
          })(),
          output: (l) => void lines.push(l),
          mock: true,
        });
        await server.start();
        await server.stop();
        const reply = JSON.parse(lines[0] ?? "{}") as { result: { kernelMode: string } };
        expect(reply.result.kernelMode).toBe(want);
      }
    } finally {
      if (saved === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = saved;
    }
  });
});

describe("P5: /files buckets reconcile with the registry", () => {
  const rt = (model: string, providerName: string) => ({ model, providerName, sessionId: "s1-files" }) as unknown as Runtime;
  test("visible + deferred + routed equals every registered tool", () => {
    const r = describeTools(rt("claude-sonnet-4-5", "anthropic"));
    expect(r?.total).toBe(tools.length);
    expect(r?.deferred).toContain("preview");
    expect(r?.visible).not.toContain("preview");
    expect(r?.routed).toEqual([]);
  });
  test("a GPT-family model moves routing-disabled tools into the hidden bucket", () => {
    const r = describeTools(rt("gpt-5-codex", "openai"));
    expect(r?.total).toBe(tools.length);
    expect(r?.routed).toContain("edit");
    expect(r?.visible).not.toContain("edit");
  });
});

describe("P6: every turn reports an exit, plan mode included", () => {
  test("a plan-mode turn returns a succeeded exit; exitLine is silent for clean ends only", async () => {
    const ws = tempDir("hz-s1-plan-");
    const rtm = await createRuntime({ workspace: ws, mock: true });
    try {
      (rtm as unknown as { provider: unknown }).provider = createScriptedProvider([{ kind: "text", text: "planned." }]);
      rtm.setPlanMode?.(true);
      const res = await rtm.send("plan something", { onEvent: () => undefined });
      expect(res.exit).toEqual({ terminal: "succeeded", detail: "turn_end" });
    } finally {
      await rtm.close();
    }
    const closed = await rtm.send("again", { onEvent: () => undefined });
    expect(closed.exit?.terminal).toBe("failed");
    expect(exitLine({ terminal: "succeeded", detail: "turn_end" })).toBeUndefined();
    expect(exitLine({ terminal: "failed", detail: "tool_loop" })).toBe("turn ended: failed (tool_loop)");
  });
});

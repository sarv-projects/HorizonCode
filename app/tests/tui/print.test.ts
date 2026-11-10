/**
 * print.test.ts: `hzcode -p` (headless print mode, FEAT-002).
 * Spawns the real entry point with the offline mock provider.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/contracts";
import { MOCK_GREETING } from "../../src/core/providers/mock";
import { filesInDiff, runPrint } from "../../src/tui/print";
import { appSpec, createWorkspacePool, killAllProcesses, runApp } from "./harness";

const pool = createWorkspacePool();
afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

const run = (ws: string, args: string[], input = "") =>
  runApp(appSpec(["--workspace", ws, "--mock", ...args]), input);

describe("hzcode -p", () => {
  test("text: prints only the final answer, exit 0", async () => {
    const r = await run(pool.make(), ["-p", "hello"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(MOCK_GREETING + "\n");
  });

  test("json: one result object with sessionId, exit, toolCalls, changedFiles", async () => {
    const r = await run(pool.make({ "a.txt": "a\n" }), ["-p", "list files", "--output-format", "json"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    const o = JSON.parse(lines[0] as string);
    expect(o.type).toBe("result");
    expect(typeof o.result).toBe("string");
    expect(o.sessionId.length).toBeGreaterThan(0);
    expect(o.exit).toMatchObject({ terminal: "succeeded", code: 0 });
    expect(o.toolCalls).toBe(1);
    expect(o.changedFiles).toEqual([]);
    expect("usage" in o).toBe(true);
  });

  test("stream-json: NDJSON events, then the result object last", async () => {
    const r = await run(pool.make(), ["-p", "hello", "--output-format=stream-json"]);
    expect(r.code).toBe(0);
    const objs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(objs.length).toBeGreaterThan(1);
    expect(objs.some((o) => o.type === "assistant.done")).toBe(true);
    expect(objs[objs.length - 1].type).toBe("result");
    expect(objs.slice(0, -1).every((o) => o.type !== "result")).toBe(true);
  });

  test("prompt comes from stdin when -p has no text", async () => {
    const r = await run(pool.make(), ["-p"], "hello from stdin\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(MOCK_GREETING + "\n");
  });

  test("-p with no text and empty stdin is a usage error (2)", async () => {
    const r = await run(pool.make(), ["-p"], "");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("bad or orphan --output-format is a usage error (2)", async () => {
    expect((await run(pool.make(), ["-p", "x", "--output-format", "xml"])).code).toBe(2);
    expect((await run(pool.make(), ["--output-format", "json"])).code).toBe(2);
  });

  test("line-per-message headless mode still works without -p", async () => {
    const r = await run(pool.make(), [], "hello\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("\u276f hello");
  });
});

describe("runPrint (unit)", () => {
  const fake = (exit: unknown, events: unknown[] = []): Runtime =>
    ({
      sessionId: "sess-1",
      model: "m",
      providerName: "p",
      kernelMode: "trusted",
      abort() {},
      async close() {},
      async send(_t: string, cb: { onEvent(ev: unknown): void }) {
        for (const e of events) cb.onEvent(e);
        return { text: "answer", aborted: false, exit };
      },
    }) as unknown as Runtime;

  test("exit codes come from exitCodeFor", async () => {
    const out: string[] = [];
    const code = await runPrint({
      runtime: fake({ terminal: "denied" }),
      prompt: "x",
      format: "json",
      write: (c) => void out.push(c),
    });
    expect(code).toBe(4);
    expect(JSON.parse(out.join("")).exit).toMatchObject({ terminal: "denied", code: 4 });
  });

  test("changedFiles, toolCalls and usage are collected", async () => {
    const out: string[] = [];
    const diff = "--- a/x.ts\n+++ b/x.ts\n+1\n--- a/gone.ts\n+++ /dev/null\n-1\n";
    const code = await runPrint({
      runtime: fake({ terminal: "succeeded" }, [
        { type: "tool.card", callId: "1", name: "edit", args: {}, status: "running" },
        { type: "tool.card", callId: "1", name: "edit", args: {}, status: "ok" },
        { type: "turn.diff", turn: 1, files: 2, diff },
        { type: "context.usage", model: "m", window: 100, estimatedInput: 7, maxOutput: 1, messages: 1, historyLimit: 1 },
      ]),
      prompt: "x",
      format: "json",
      write: (c) => void out.push(c),
    });
    expect(code).toBe(0);
    const o = JSON.parse(out.join(""));
    expect(o.toolCalls).toBe(1);
    expect(o.changedFiles).toEqual(["x.ts", "gone.ts"]);
    expect(o.usage).toEqual({ model: "m", contextWindow: 100, estimatedInputTokens: 7 });
    expect(filesInDiff(diff)).toEqual(["x.ts", "gone.ts"]);
  });
});

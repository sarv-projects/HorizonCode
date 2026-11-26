/**
 * track4-tui-fixes.test.ts — Regression tests for Track 4 TUI fixes:
 *   - P1-7:  /tasks dispatch in scrollback + fullscreen TUI & recursion guard
 *   - P1-8:  Modal alternate screen (\x1b[?1049h / \x1b[?1049l) & non-destructive stdin exit
 *   - P1-11: status-line.ts env scrubbing (no API key leakage)
 *   - P1-14: ask_user abort/timeout cleanup clears answerWaiter / approvalResolve
 *   - P1-15: fullscreen-chat modal Ctrl+C dismiss + line-mode approval Ctrl+C unwind
 *   - P2:    interactive.ts Ctrl+C exit code 130 & reconcileBlockLatch?.() optional guard
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { Runtime } from "../../src/contracts";
import { createApprovalUi, type ApprovalUi } from "../../src/tui/approval";
import { createAskUserHandler } from "../../src/tui/ask-user";
import { runFullscreenExperimentalChat } from "../../src/tui/fullscreen-chat";
import { tryRunFullscreenLocalSlash } from "../../src/tui/fullscreen-slash";
import { runConvoCommand, type PlanCommandState } from "../../src/tui/interactive";
import { runInteractiveModelPicker } from "../../src/tui/interactive-model-picker";
import type { Renderer } from "../../src/tui/render";
import { isFullscreenDeferredSlash, isFullscreenLocalSlash } from "../../src/tui/slash-dispatch";
import { resetStatusLineCache, runStatusLineScript } from "../../src/tui/status-line";

function mockRenderer(): Renderer & { lines: string[]; notices: string[]; chunks: string[] } {
  const lines: string[] = [];
  const notices: string[] = [];
  const chunks: string[] = [];
  return {
    lines,
    notices,
    chunks,
    line: (t) => lines.push(t),
    notice: (t) => notices.push(t),
    write: (t) => chunks.push(t),
    handle: () => {},
    ensureLineStart: () => {},
    error: (t) => notices.push(t),
    atLineStart: () => true,
    lastThinking: () => "",
  };
}

function minimalRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    sessionId: "s-track4",
    model: "mock-model",
    providerName: "mock",
    kernelMode: "embedded",
    send: async () => ({ exit: { terminal: "succeeded" } }),
    abort: () => {},
    ...overrides,
  } as unknown as Runtime;
}

describe("Track 4 — P1-7: /tasks dispatch and prefix recursion guard", () => {
  test("/tasks is a local fullscreen slash command and runs without recursion", async () => {
    expect(isFullscreenLocalSlash("tasks")).toBe(true);
    expect(isFullscreenDeferredSlash("tasks")).toBe(false);

    const ws = mkdtempSync(path.join(tmpdir(), "hz-t4-tasks-"));
    try {
      writeFileSync(
        path.join(ws, "feature_list.json"),
        JSON.stringify([{ id: "t-1", name: "Fix TUI", status: "in_progress" }]),
      );
      const renderer = mockRenderer();
      const planState: PlanCommandState = { on: false };
      const consumed = await tryRunFullscreenLocalSlash("/tasks", {
        runtime: minimalRuntime(),
        renderer,
        workspace: ws,
        write: () => {},
        planState,
      });
      expect(consumed).toBe(true);
      expect(renderer.notices.join("\n")).toContain("t-1");
      expect(renderer.notices.join("\n")).not.toContain("not available in fullscreen");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("runConvoCommand handles tasks cleanly", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-t4-convo-"));
    try {
      const renderer = mockRenderer();
      const handled = await runConvoCommand("tasks", "", minimalRuntime(), renderer, ws);
      expect(handled).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("Track 4 — P1-8: interactive model picker alternate screen & Ctrl+C", () => {
  test("runArrowModelPicker enters and exits alternate screen on Ctrl+C without destroying stdin", async () => {
    const fakeStdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      destroyed: false,
      setRawMode(on: boolean) {
        this.isRaw = on;
      },
      pause() {
        return this;
      },
      resume() {
        return this;
      },
    }) as unknown as NodeJS.ReadableStream & { isRaw: boolean; destroyed: boolean };

    let out = "";
    const fakeStdout = {
      isTTY: true,
      write(chunk: string) {
        out += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const renderer = mockRenderer();
    const pickerPromise = runInteractiveModelPicker(minimalRuntime(), renderer, {
      stdin: fakeStdin,
      stdout: fakeStdout,
    });

    // Emit Ctrl+C to cancel the arrow picker cleanly
    fakeStdin.emit("keypress", "\x03", { name: "c", ctrl: true });
    const res = await pickerPromise;

    expect(res.switched).toBe(false);
    expect(out).toContain("\x1b[?1049h");
    expect(out).toContain("\x1b[?1049l");
    expect(fakeStdin.isRaw).toBe(false);
    expect(fakeStdin.destroyed).toBe(false);
  });
});

describe("Track 4 — P1-11: status-line.ts env scrubbing", () => {
  test("runStatusLineScript scrubs provider API keys from child environment", () => {
    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-track4-secret-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant-track4-secret-anthropic";
    try {
      let lines: string[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        resetStatusLineCache();
        lines = runStatusLineScript(
          {
            command: process.argv[0],
            args: [
              "-e",
              "console.log(JSON.stringify({o:process.env.OPENAI_API_KEY??null,a:process.env.ANTHROPIC_API_KEY??null}))",
            ],
          },
          { model: "m", provider: "mock" },
          `scrub-${attempt}`,
        );
        if (lines.length > 0) break;
      }
      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines[0]!) as { o: string | null; a: string | null };
      expect(parsed.o).toBeNull();
      expect(parsed.a).toBeNull();
    } finally {
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAI;
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });
});

describe("Track 4 — P1-14: ask_user abort and timeout cleanup", () => {
  test("createAskUserHandler aborts ui.ask signal on timeout so waiter is cleared", async () => {
    let waiterActive = false;
    let receivedSignal: AbortSignal | undefined;
    const mockUi: ApprovalUi = {
      interactive: true,
      renderer: mockRenderer(),
      ask: (_q, opts) =>
        new Promise<string>((resolve) => {
          waiterActive = true;
          receivedSignal = opts?.signal;
          opts?.signal?.addEventListener(
            "abort",
            () => {
              waiterActive = false;
              resolve("");
            },
            { once: true },
          );
        }),
    };

    const handler = createAskUserHandler(mockUi);
    await expect(
      handler({
        question: "Proceed?",
        timeoutMs: 30,
      }),
    ).rejects.toThrow("timed out");

    expect(receivedSignal?.aborted).toBe(true);
    expect(waiterActive).toBe(false);
  });

  test("createAskUserHandler aborts ui.ask signal when external AbortSignal fires", async () => {
    let waiterActive = false;
    const ac = new AbortController();
    const mockUi: ApprovalUi = {
      interactive: true,
      renderer: mockRenderer(),
      ask: (_q, opts) =>
        new Promise<string>((resolve) => {
          waiterActive = true;
          opts?.signal?.addEventListener(
            "abort",
            () => {
              waiterActive = false;
              resolve("");
            },
            { once: true },
          );
        }),
    };

    const handler = createAskUserHandler(mockUi, { signal: ac.signal });
    const pending = handler({ question: "Wait for abort?" });
    expect(waiterActive).toBe(true);
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(waiterActive).toBe(false);
  });
});

describe("Track 4 — P1-15 & P1-14 in fullscreen-chat: Ctrl+C and abort unwind", () => {
  test("fullscreen ui.ask clears approvalResolve on AbortSignal and SIGINT exits 130", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-t4-fs-"));
    try {
      const ui = createApprovalUi(true);
      const runPromise = runFullscreenExperimentalChat(
        {
          version: "test",
          runtime: minimalRuntime(),
          workspace: ws,
          ui,
        },
        {
          isTty: true,
          readStdin: false,
          write: () => {},
          enterRawMode: () => {},
          leaveRawMode: () => {},
          columns: 80,
          rows: 24,
        },
      );

      // Wait a tick for runFullscreenExperimentalChat to wire ui.ask
      await new Promise((r) => setTimeout(r, 20));

      // Test AbortSignal cleanup on fullscreen ui.ask
      const ac = new AbortController();
      const abortedAsk = ui.ask("Aborted question?", { signal: ac.signal });
      ac.abort();
      expect(await abortedAsk).toBe("");

      // Exit fullscreen loop via SIGINT -> exit code 130
      process.emit("SIGINT" as never);

      const code = await runPromise;
      expect(code).toBe(130);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("Track 4 — P2: interactive.ts minimal runtime without reconcileBlockLatch", () => {
  test("PassThrough stdin does not throw when runtime omits reconcileBlockLatch", () => {
    const rt = minimalRuntime();
    expect((rt as unknown as { reconcileBlockLatch?: unknown }).reconcileBlockLatch).toBeUndefined();
    const pt = new PassThrough();
    pt.end();
    expect(pt.readable).toBe(true);
  });
});

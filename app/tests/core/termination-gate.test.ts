import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  detectWorkspaceVerificationCommand,
  evaluateTerminationGate,
  terminationGateEnabled,
  TERMINATION_GATE_INTERCEPT_EVENT,
} from "../../src/core/termination-gate";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { SessionStore } from "../../src/core/session";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";

describe("Three-Layer Termination Gate (Harness Engineering Lecture 09)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-term-gate-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("terminationGateEnabled respects env flag", () => {
    expect(terminationGateEnabled({ HZ_TERMINATION_GATE: "1" })).toBe(true);
    expect(terminationGateEnabled({ HZ_TERMINATION_GATE: "true" })).toBe(true);
    expect(terminationGateEnabled({ HZ_TERMINATION_GATE: "0" })).toBe(false);
    expect(terminationGateEnabled({})).toBe(false);
  });

  test("workspace verification command detection", () => {
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    expect(detectWorkspaceVerificationCommand(workspace)).toContain("test");
  });

  test("evaluates canTerminate true when no files mutated", () => {
    const res = evaluateTerminationGate({
      changedPaths: [],
      workspace,
    });
    expect(res.canTerminate).toBe(true);
    expect(res.failingLayer).toBeUndefined();
  });

  test("evaluates canTerminate false with unverified layer when mutations exist without check", () => {
    const res = evaluateTerminationGate({
      changedPaths: ["src/index.ts", "src/auth.ts"],
      workspace,
    });
    expect(res.canTerminate).toBe(false);
    expect(res.failingLayer).toBe("unverified");
    expect(res.feedback).toContain("Premature victory prevented");
    expect(res.feedback).toContain("Layer 1");
    expect(res.feedback).toContain("Layer 2");
    expect(res.feedback).toContain("src/index.ts, src/auth.ts");
  });

  test("evaluates canTerminate false with tests layer when verification command exited with error", () => {
    const res = evaluateTerminationGate({
      changedPaths: ["src/index.ts"],
      verifiedCommand: "bun test",
      lastCommandExitCode: 1,
      workspace,
    });
    expect(res.canTerminate).toBe(false);
    expect(res.failingLayer).toBe("tests");
    expect(res.feedback).toContain("failed with exit code 1");
  });

  test("evaluates canTerminate true when verification command succeeded", () => {
    const res = evaluateTerminationGate({
      changedPaths: ["src/index.ts"],
      verifiedCommand: "bun test",
      lastCommandExitCode: 0,
      workspace,
    });
    expect(res.canTerminate).toBe(true);
  });
});

describe("Termination Gate loop integration", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-term-loop-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

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

  function calls(...specs: Array<{ name: string; args: Record<string, unknown> }>): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    specs.forEach((spec, i) => {
      events.push({ type: "tool_call", id: `call_${i + 1}`, name: spec.name, arguments: JSON.stringify(spec.args) });
    });
    events.push({ type: "done", stopReason: "tool_use" });
    return events;
  }

  const DONE: ProviderEvent[] = [{ type: "done", stopReason: "end" }];

  test("intercepts turn completion when HZ_TERMINATION_GATE=1 and model modifies file without verifying", async () => {
    const origEnv = process.env.HZ_TERMINATION_GATE;
    process.env.HZ_TERMINATION_GATE = "1";
    try {
      const provider = scriptedProvider([
        calls({ name: "write", args: { path: "fix.txt", content: "data\n" } }),
        DONE, // Model tries to conclude without verification
        calls({ name: "shell", args: { command: "make --version" } }), // Model runs verification after intercept!
        DONE,
      ]);

      const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
      const store = new SessionStore(workspace);
      const seen: RuntimeEvent[] = [];
      const deps: LoopDeps = {
        workspace,
        sessionId: store.createSession("term-gate").id,
        model: "scripted-1",
        provider,
        kernel,
        store,
        signal: new AbortController().signal,
        callbacks: { onEvent: (ev) => seen.push(ev) },
        sessionLeases: [],
        approve: async () => true,
      };

      try {
        const result = await runTurn(deps, "fix the bug");
        expect(result.exit.terminal).toBe("succeeded");

        // Verify intercept notice was emitted
        const interceptNotices = seen
          .filter((ev): ev is { type: "notice"; message: string } => ev.type === "notice")
          .map((ev) => ev.message)
          .filter((msg) => msg.includes("termination gate"));
        expect(interceptNotices.length).toBeGreaterThan(0);

        // Verify audit event was recorded
        const events = await kernel.readEvents(`session:${deps.sessionId}`);
        const interceptEvent = events.find((e) => e.type === TERMINATION_GATE_INTERCEPT_EVENT);
        expect(interceptEvent).toBeDefined();
      } finally {
        await kernel.close();
        store.close();
      }
    } finally {
      if (origEnv !== undefined) process.env.HZ_TERMINATION_GATE = origEnv;
      else delete process.env.HZ_TERMINATION_GATE;
    }
  }, 25000);
});

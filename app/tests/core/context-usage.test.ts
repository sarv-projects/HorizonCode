/**
 * context-usage.test.ts — the `/context` report: a RuntimeEvent the harness
 * emits per dispatch with its own estimate of what the next request carries.
 *
 * The numbers must come from the harness (token estimator / window table /
 * compaction limit), never from a provider response, and the runtime must keep
 * the newest snapshot for the chat bar's `/context` command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ContextUsage, Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { KernelClient } from "../../src/core/kernel";
import { HISTORY_LIMIT, runTurn } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-context-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("context.usage", () => {
  test("the mock runtime reports its context snapshot after a turn", async () => {
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      const seen: RuntimeEvent[] = [];
      await runtime.send("hello", { onEvent: (ev) => seen.push(ev) });

      const usage = seen.filter((ev): ev is { type: "context.usage" } & ContextUsage => ev.type === "context.usage");
      expect(usage.length).toBeGreaterThan(0);
      const first = usage[0]!;
      expect(first.window).toBeGreaterThan(0);
      expect(first.estimatedInput).toBeGreaterThan(0);
      expect(first.maxOutput).toBeGreaterThan(0);
      expect(first.messages).toBeGreaterThan(0);
      expect(first.historyLimit).toBe(HISTORY_LIMIT);

      // The runtime keeps the newest snapshot for /context, and the model name
      // it reports is the one the dispatch actually used.
      const kept = runtime.contextUsage();
      expect(kept).toBeDefined();
      expect(kept!.model).toBe(runtime.model);
      expect(kept!.window).toBe(first.window);
    } finally {
      await runtime.close();
    }
  }, 30000);

  test("no snapshot exists before any dispatch ran", async () => {
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      expect(runtime.contextUsage()).toBeUndefined();
    } finally {
      await runtime.close();
    }
  }, 30000);

  test("the snapshot is the harness's, emitted before the provider answers (even a failing one)", async () => {
    // The event is emitted before the request: even a throwing provider sees
    // the harness's own estimate — the report is never the provider's word.
    const kernel = new KernelClient({ workspace });
    const store = new SessionStore(workspace);
    const exploding: Provider = {
      name: "exploding",
      async *stream(): AsyncIterable<ProviderEvent> {
        throw new Error("no model today");
      },
    };
    const seen: RuntimeEvent[] = [];
    try {
      const result = await runTurn(
        {
          workspace,
          sessionId: store.createSession("ctx").id,
          model: "scripted-1",
          provider: exploding,
          kernel,
          store,
          signal: new AbortController().signal,
          callbacks: { onEvent: (ev) => seen.push(ev) },
          sessionLeases: [],
        },
        "hello",
      );
      expect(result.exit.terminal).toBe("failed");
      const usage = seen.filter((ev) => ev.type === "context.usage");
      expect(usage.length).toBeGreaterThan(0);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 30000);
});

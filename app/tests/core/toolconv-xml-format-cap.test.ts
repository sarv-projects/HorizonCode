/**
 * toolconv-xml-format-cap.test.ts — NF-073 cap via wrapped provider (docs/33 §5.14).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { exitCodeFor, MAX_CONSECUTIVE_FORMAT_ERRORS, runTurn, type LoopDeps } from "../../src/core/loop";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-xml-cap-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const badBatch = (): ProviderEvent[] => [
  { type: "tool_call", id: "bad_1", name: "read", arguments: "{{{ not json" },
  { type: "done", stopReason: "tool_use" },
];

const DONE: ProviderEvent[] = [{ type: "text", text: "ok" }, { type: "done", stopReason: "end" }];

function xmlCapProvider(turns: ProviderEvent[][]): Provider {
  let index = 0;
  const inner: Provider = {
    name: "scripted",
    async *stream(req) {
      for (const event of turns[Math.min(index++, turns.length - 1)] ?? []) yield event;
    },
  };
  return wrapXmlToolProvider(inner);
}

describe("xml-wrapped format-error cap", () => {
  test("three invalid-json tool batches exit format_errors", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("xml-cap").id,
      model: "scripted-1",
      provider: xmlCapProvider([badBatch(), badBatch(), badBatch(), DONE]),
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          events.push(ev as { type: string; message?: string });
        },
      },
      sessionLeases: [],
      approve: async () => true,
      budget: { maxSteps: 100 },
    };
    try {
      const result = await runTurn(deps, "bad json");
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("format_errors");
      expect(exitCodeFor(result.exit)).toBe(1);
      expect(
        events.some(
          (e) =>
            e.type === "error" &&
            (e.message ?? "").includes(`${MAX_CONSECUTIVE_FORMAT_ERRORS} consecutive turns`),
        ),
      ).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

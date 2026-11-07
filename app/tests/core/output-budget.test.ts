/**
 * output-budget.test.ts — NF-074 context-cost contracts (v0.1 slice).
 *
 * Acceptance docs/24 §12.2 #66: the output cap fits the remaining window
 * with the measured headway; over-cap tool output spills with a pointer
 * (the shell-minimiser half lives in tests/tools/shell-minimiser.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_WINDOW_TOKENS,
  estimatePromptTokens,
  estimateTokens,
  fitMaxOutputTokens,
  FRAMING_CHARGE_TOKENS,
  MIN_OUTPUT_TOKENS,
  planToolOutputCap,
  windowForModel,
} from "../../src/core/output-budget";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { SessionStore } from "../../src/core/session";
import { receiptsFilePath, readJsonl } from "./helpers";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-budget-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/* ------------------------------- pure maths ------------------------------- */

describe("local estimates (fitting only, never accounting)", () => {
  test("estimateTokens: bytes / 4, multibyte counted by UTF-8 bytes", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
    expect(estimateTokens("é".repeat(4))).toBe(2);
    expect(estimateTokens("abc")).toBe(1);
  });

  test("windowForModel: claude 200k, gpt-4o 128k, unknown takes the default", () => {
    expect(windowForModel("claude-sonnet-4-5")).toBe(200 * 1024);
    expect(windowForModel("gpt-4o-mini")).toBe(128 * 1024);
    expect(windowForModel("gpt-4.1")).toBe(128 * 1024);
    expect(windowForModel("some-local-model")).toBe(DEFAULT_WINDOW_TOKENS);
  });

  test("estimatePromptTokens charges the framing constant per message", () => {
    // system "abcd" = 1 token; one message "abcd" = 1 + 16 framing.
    expect(estimatePromptTokens("abcd", [{ role: "user", content: "abcd" }])).toBe(1 + FRAMING_CHARGE_TOKENS + 1);
    // tool-call arguments and the tool schema blob are counted too.
    const withCall = estimatePromptTokens("", [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "a".repeat(40) }] },
    ]);
    expect(withCall).toBe(FRAMING_CHARGE_TOKENS + 10);
    expect(estimatePromptTokens("", [], "x".repeat(40))).toBe(10);
  });

  test("fitMaxOutputTokens: default ceiling, headway, and the floor", () => {
    expect(fitMaxOutputTokens(1000)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    // 124k input against a 128k window: 131072 - 124000 - 4096 = 2976.
    expect(fitMaxOutputTokens(124_000, DEFAULT_WINDOW_TOKENS)).toBe(2_976);
    expect(fitMaxOutputTokens(DEFAULT_WINDOW_TOKENS - 4096, DEFAULT_WINDOW_TOKENS)).toBe(MIN_OUTPUT_TOKENS);
    expect(fitMaxOutputTokens(10_000_000, DEFAULT_WINDOW_TOKENS)).toBe(MIN_OUTPUT_TOKENS);
    expect(fitMaxOutputTokens(-5)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

/* ------------------------------ the caps ------------------------------ */

describe("planToolOutputCap: under the cap means untouched", () => {
  test("a small result is returned byte-identical with no truncation record", () => {
    const text = "hello\nworld\n";
    const plan = planToolOutputCap(text);
    expect(plan.text).toBe(text);
    expect(plan.truncated).toBeUndefined();
    expect(plan.spill).toBeUndefined();
  });
});

describe("planToolOutputCap: over the cap truncates, losslessly-resumable", () => {
  const full = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n") + "\n";

  test("kept prefix + nextOffset reconstruct exactly where the next slice starts", () => {
    const plan = planToolOutputCap(full, { maxBytes: 200, maxTokens: 1000 });
    expect(plan.truncated?.reason).toBe("bytes");
    expect(plan.text).toContain("[truncated:");
    const prefix = plan.text.slice(0, plan.text.indexOf("[truncated:"));
    expect(full.startsWith(prefix.replace(/\n$/, ""))).toBe(true);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(plan.truncated?.nextOffset ?? -1);
    expect(plan.truncated?.omittedBytes).toBe(Buffer.byteLength(full, "utf8") - (plan.truncated?.nextOffset ?? 0));
    expect(plan.truncated?.omittedLines).toBeGreaterThan(0);
  });

  test("a token-binding budget reports reason tokens", () => {
    const plan = planToolOutputCap(full, { maxBytes: 10_000, maxTokens: 10 });
    expect(plan.truncated?.reason).toBe("tokens");
    const prefix = plan.text.slice(0, plan.text.indexOf("[truncated:"));
    expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(40 + 1);
  });

  test("a spill carries the full text under its sha256 name and a marker pointer", () => {
    const plan = planToolOutputCap(full, {
      maxBytes: 120,
      spillDir: path.join(workspace, "spills"),
      displaySpillDir: ".hzcode/spills",
    });
    expect(plan.spill?.contents).toBe(full);
    expect(plan.spill?.file.endsWith(`${sha256Hex(full)}.txt`)).toBe(true);
    expect(plan.text).toContain(`.hzcode/spills/${sha256Hex(full)}.txt`);
    expect(plan.truncated?.spillPath?.endsWith(`${sha256Hex(full)}.txt`)).toBe(true);
  });

  test("over the 64 MiB stream cap the call refuses to spill", () => {
    const plan = planToolOutputCap("x".repeat(100), { maxStreamBytes: 50, spillDir: path.join(workspace, "spills") });
    expect(plan.text).toContain("output too large");
    expect(plan.truncated?.omittedBytes).toBe(100);
    expect(plan.spill).toBeUndefined();
  });
});

/* --------------------------- loop integration --------------------------- */

function scriptedProvider(turns: ProviderEvent[][], captured: Array<{ maxTokens?: number }>): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream(req) {
      captured.push({ maxTokens: req.maxTokens });
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

function depsFor(provider: Provider, budget: Record<string, number>): { deps: LoopDeps; kernel: KernelClient; store: SessionStore } {
  // Default state resolution: a fresh workspace uses the canonical tree.
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("budget").id,
    model: "gpt-4o-mini",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve: async () => true,
    budget,
  };
  return { deps, kernel, store };
}

describe("the loop caps tool output and shores up the spill", () => {
  test("a 20 KB shell result is capped for the model, spilled in full, receipted on the full digest", async () => {
    const captured: Array<{ maxTokens?: number }> = [];
    const provider = scriptedProvider(
      [
        [
          { type: "tool_call", id: "call_1", name: "shell", arguments: JSON.stringify({ command: "yes x | head -c 20000" }) },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "done", stopReason: "end" }],
      ],
      captured,
    );
    const { deps, kernel, store } = depsFor(provider, { maxSteps: 5 });
    try {
      await runTurn(deps, "produce a lot");
      const content = store
        .history(deps.sessionId)
        .filter((m) => m.role === "tool" && m.toolName === "shell")
        .map((m) => m.content)
        .join("");
      expect(content).toContain("[truncated:");
      expect(content).toContain(".hz/state/spills/");
      expect(content.length).toBeLessThan(20_000);

      const spillDir = path.join(workspace, ".hz", "state", "spills");
      const files = readdirSync(spillDir);
      expect(files.length).toBe(1);
      const spill = readFileSync(path.join(spillDir, files[0] as string), "utf8");
      expect(spill.length).toBeGreaterThan(20_000);
      expect(files[0]).toBe(`${sha256Hex(spill)}.txt`);

      // The model-facing text keeps a true prefix of the full output…
      const prefix = content.slice(0, content.indexOf("[truncated:")).replace(/\n$/, "");
      expect(spill.startsWith(prefix)).toBe(true);

      // …and the receipt's digest is the digest of the FULL output, not the cap.
      const receipts = readJsonl<{ resultDigest: string }>(receiptsFilePath(path.join(workspace, ".hz", "state", "kernel")));
      expect(receipts.length).toBe(1);
      expect(receipts[0]?.resultDigest).toBe(sha256Hex(spill));
    } finally {
      await kernel.close();
      store.close();
    }
  }, 20000);

  test("the output cap follows the usage anchor on the next request", async () => {
    const captured: Array<{ maxTokens?: number }> = [];
    const provider = scriptedProvider(
      [
        [
          { type: "tool_call", id: "call_1", name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
          { type: "done", stopReason: "tool_use", usage: { inputTokens: 120_000, outputTokens: 1_000 } },
        ],
        [{ type: "done", stopReason: "end" }],
      ],
      captured,
    );
    const { deps, kernel, store } = depsFor(provider, { maxSteps: 5 });
    try {
      await runTurn(deps, "watch the cap");
      expect(captured.length).toBe(2);
      // First request: no anchor yet — the whole-prompt estimate is small.
      expect(captured[0]?.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      // Second request: 121k anchored against a 128k window leaves ~6k.
      const second = captured[1]?.maxTokens ?? 0;
      expect(second).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      expect(second).toBeLessThan(DEFAULT_MAX_OUTPUT_TOKENS);
      expect(second).toBeLessThan(7_000);
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

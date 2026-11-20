import { describe, expect, test } from "bun:test";
import type { ChatMsg, Provider, ProviderEvent, ProviderRequest } from "../../src/contracts";
import { compactHistory, summariseElided, SUMMARY_HEADING } from "../../src/core/compaction";
import {
  buildLlmCompactionPrompt,
  formatLlmCompactionSummary,
  llmCompactionEnabled,
  LLM_COMPACTION_ENV,
  resolveLlmCompactionSummariser,
  streamCompactionSummary,
  summariseElidedOrLlm,
  tryLlmSemanticCompaction,
} from "../../src/core/compaction-llm";
import { CompactionHoldBuffer } from "../../src/core/compaction-hold";

function chat(role: ChatMsg["role"], content: string): ChatMsg {
  return { role, content };
}

function seqProvider(text: string, fail = false): Provider {
  return {
    name: "inject",
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (fail) {
        yield { type: "error", message: "injected failure" };
        return;
      }
      yield { type: "text", text };
      yield { type: "done", stopReason: "end" };
    },
  };
}

describe("llmCompactionEnabled (ruling 689)", () => {
  test("default off without env or deps", () => {
    expect(llmCompactionEnabled({}, { [LLM_COMPACTION_ENV]: undefined })).toBe(false);
    expect(llmCompactionEnabled({}, { [LLM_COMPACTION_ENV]: "0" })).toBe(false);
  });

  test("env HZ_LLM_COMPACTION=1 enables", () => {
    expect(llmCompactionEnabled({}, { [LLM_COMPACTION_ENV]: "1" })).toBe(true);
  });

  test("LoopDeps.llmCompaction alone enables", () => {
    expect(llmCompactionEnabled({ llmCompaction: true }, {})).toBe(true);
  });
});

describe("streamCompactionSummary", () => {
  test("collects streamed text", async () => {
    const out = await streamCompactionSummary({
      provider: seqProvider("- did thing A\n- did thing B"),
      model: "mock-1",
      prompt: "summarize",
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(out).toBe("- did thing A\n- did thing B");
  });

  test("returns undefined on provider error", async () => {
    const out = await streamCompactionSummary({
      provider: seqProvider("", true),
      model: "mock-1",
      prompt: "summarize",
      signal: new AbortController().signal,
    });
    expect(out).toBeUndefined();
  });
});

describe("tryLlmSemanticCompaction", () => {
  test("formats provider bullets into compaction summary block", async () => {
    const elided = [chat("user", "fix the bug in auth"), chat("assistant", "read auth.ts")];
    const summary = await tryLlmSemanticCompaction(
      { provider: seqProvider("- user asked to fix auth bug"), model: "gpt-4o", signal: new AbortController().signal },
      elided,
      10,
      8,
      {},
    );
    expect(summary).toContain(SUMMARY_HEADING);
    expect(summary).toContain("summary source: semantic");
    expect(summary).toContain("- user asked to fix auth bug");
  });

  test("returns undefined when provider fails (fail closed)", async () => {
    const elided = [chat("user", "x"), chat("assistant", "y")];
    const summary = await tryLlmSemanticCompaction(
      { provider: seqProvider("", true), model: "gpt-4o", signal: new AbortController().signal },
      elided,
      10,
      8,
    );
    expect(summary).toBeUndefined();
  });
});

describe("summariseElidedOrLlm", () => {
  test("uses llm block when present", () => {
    const elided = [chat("user", "a")];
    const deterministic = summariseElided(elided, 5, 4);
    const merged = summariseElidedOrLlm(elided, 5, 4, "LLM-ONLY-BODY");
    expect(merged).toBe("LLM-ONLY-BODY");
    expect(merged).not.toBe(deterministic);
  });

  test("falls back to deterministic summariseElided", () => {
    const elided = [chat("user", "a")];
    const deterministic = summariseElided(elided, 5, 4);
    expect(summariseElidedOrLlm(elided, 5, 4)).toBe(deterministic);
  });
});

describe("compactHistory with injected elidedSummariser", () => {
  test("uses semantic summariser instead of deterministic body", () => {
    const history: ChatMsg[] = [];
    for (let i = 0; i < 12; i += 1) {
      history.push(chat(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));
    }
    const semantic = formatLlmCompactionSummary("- semantic recap line", history.slice(0, 4), 12, 8);
    const result = compactHistory(history, {
      limit: 8,
      elidedSummariser: () => semantic,
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("semantic recap line");
    expect(result.summary).not.toContain("tools called in the elided turns");
  });
});

describe("resolveLlmCompactionSummariser", () => {
  test("skips provider call when hold would swap", async () => {
    let called = false;
    const provider: Provider = {
      name: "inject",
      async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
        called = true;
        yield { type: "text", text: "nope" };
        yield { type: "done", stopReason: "end" };
      },
    };
    const history: ChatMsg[] = [];
    for (let i = 0; i < 12; i += 1) history.push(chat(i % 2 === 0 ? "user" : "assistant", `m${i}`));
    const hold = new CompactionHoldBuffer();
    const elided = history.slice(0, 4);
    hold.prepareHold(elided, 12, 8);
    const summariser = await resolveLlmCompactionSummariser(
      { llmCompaction: true, provider, model: "gpt-4o", signal: new AbortController().signal },
      history,
      8,
      hold,
    );
    expect(summariser).toBeUndefined();
    expect(called).toBe(false);
  });

  test("returns constant summariser when provider succeeds", async () => {
    const history: ChatMsg[] = [];
    for (let i = 0; i < 12; i += 1) history.push(chat(i % 2 === 0 ? "user" : "assistant", `m${i}`));
    const summariser = await resolveLlmCompactionSummariser(
      {
        llmCompaction: true,
        provider: seqProvider("- recap from model"),
        model: "gpt-4o",
        signal: new AbortController().signal,
      },
      history,
      8,
    );
    expect(summariser).toBeDefined();
    const text = summariser!(history.slice(0, 4), 12, 8);
    expect(text).toContain("recap from model");
  });
});

describe("buildLlmCompactionPrompt", () => {
  test("includes elided excerpt and bounds", () => {
    const elided = [chat("user", "hello"), chat("assistant", "world")];
    const prompt = buildLlmCompactionPrompt(elided, 20, 8);
    expect(prompt).toContain("2 of 20 messages");
    expect(prompt).toContain("(user) hello");
  });
});
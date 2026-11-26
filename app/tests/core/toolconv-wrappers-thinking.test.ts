/**
 * toolconv-wrappers-thinking.test.ts — wrappers must forward the signed thinking echo.
 *
 * A text-dialect wrapper buffers text and re-emits a fresh `done` at the end. It
 * used to forward only stopReason/usage, dropping `done.thinking`, so the signed
 * Anthropic thinking block could never be replayed on a wrapped provider.
 */

import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";
import { wrapHermesToolProvider } from "../../src/core/providers/toolconv/wrap-hermes";
import { wrapDeepseekToolProvider } from "../../src/core/providers/toolconv/wrap-deepseek";

function fakeInner(): Provider {
  return {
    name: "fake",
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "text", text: "hello" };
      yield { type: "done", stopReason: "end", thinking: { text: "why", signature: "sig" } };
    },
  };
}

async function collect(provider: Provider): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of provider.stream({ model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal })) {
    out.push(ev);
  }
  return out;
}

describe("toolconv wrappers preserve done.thinking", () => {
  for (const [name, wrap] of [
    ["xml", wrapXmlToolProvider],
    ["hermes", wrapHermesToolProvider],
    ["deepseek", wrapDeepseekToolProvider],
  ] as const) {
    test(name, async () => {
      const events = await collect(wrap(fakeInner()));
      const done = events.find((e) => e.type === "done") as Extract<ProviderEvent, { type: "done" }> | undefined;
      expect(done?.thinking).toEqual({ text: "why", signature: "sig" });
    });
  }
});

/**
 * toolconv-history-rewrite.test.ts — D-8: history replay round-trips per dialect.
 *
 * For every in-band dialect the rewrite must emit text THAT DIALECT's own parser
 * reads back as the same call. Before this, seven dialects replayed Hermes
 * blocks, which their parsers could not read at all.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { rewriteHistoryForTextToolconv } from "../../src/core/providers/toolconv/history-rewrite";
import { parseDeepseekToolCalls } from "../../src/core/providers/toolconv/deepseek";
import { parseGeminiToolCalls } from "../../src/core/providers/toolconv/gemini";
import { parseGemmaToolCalls } from "../../src/core/providers/toolconv/gemma";
import { parseGlmToolCalls } from "../../src/core/providers/toolconv/glm";
import { parseHarmonyToolCalls } from "../../src/core/providers/toolconv/harmony";
import { parseKimiToolCalls } from "../../src/core/providers/toolconv/kimi";
import { parseMinimaxToolCalls } from "../../src/core/providers/toolconv/minimax";
import type { ToolFormat } from "../../src/core/config";

const allowed = new Set(["write"]);
const history = (args: Record<string, unknown>): ChatMsg[] => [
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write", arguments: JSON.stringify(args) }] },
  { role: "tool", content: "ok", toolCallId: "c1", toolName: "write" },
];

function assistantText(dialect: ToolFormat, args: Record<string, unknown>): string {
  const out = rewriteHistoryForTextToolconv(history(args), dialect);
  return out.filter((m) => m.role === "assistant").map((m) => String(m.content)).join("\n");
}

const cases: Array<[ToolFormat, (text: string, allowed: ReadonlySet<string>) => unknown]> = [
  ["deepseek", parseDeepseekToolCalls],
  ["gemini", parseGeminiToolCalls],
  ["gemma", parseGemmaToolCalls],
  ["glm", parseGlmToolCalls],
  ["harmony", parseHarmonyToolCalls],
  ["kimi", parseKimiToolCalls],
  ["minimax", parseMinimaxToolCalls],
  ["anthropic", parseMinimaxToolCalls],
];

describe("history rewrite round-trips", () => {
  for (const [dialect, parse] of cases) {
    test(dialect + ": its own parser reads the replayed call", () => {
      const args = { path: "a.txt", content: "hello" };
      const parsed = parse(assistantText(dialect, args), allowed) as {
        calls: Array<{ name: string; args: Record<string, unknown> }>;
        errors: string[];
      };
      expect(parsed.errors).toEqual([]);
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls[0]?.name).toBe("write");
      expect(parsed.calls[0]?.args).toEqual(args);
    });
  }
});

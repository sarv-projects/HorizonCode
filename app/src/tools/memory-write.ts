/**
 * `memory_remember` / `memory_forget` — mnemopi-style FTS bank writes (docs/30 §8 #4 ADAPT).
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { PROJECT_BANK, parseMemoryBankId, type MemoryBankId } from "../core/memory/banks";
import { MEMORY_FACT_MAX_CHARS } from "../core/memory/store";
import { forgetMemoryFacts, rememberMemoryFact } from "../core/memory/store";

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

function parseBankArg(raw: unknown): MemoryBankId | undefined {
  if (raw === undefined || raw === null) return PROJECT_BANK;
  if (typeof raw !== "string") return undefined;
  const bank = parseMemoryBankId(raw.trim());
  return bank;
}

export const memoryRememberTool: Tool = {
  name: "memory_remember",
  description:
    `Store a fact in a memory bank (FTS index). Default bank is project (.hz/state/memory.db). user and shared banks live in the user config dir. Does not edit MEMORY.md. Max ${MEMORY_FACT_MAX_CHARS} chars.`,
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Fact text to retain for later recall." },
      bank: { type: "string", enum: ["project", "user", "shared"], description: "Target bank (default project)." },
    },
    required: ["content"],
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "remember", "recall", "fact", "bank", "mnemopi"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content : "";
    const bank = parseBankArg(args.bank);
    if (bank === undefined) return fail("invalid bank");
    const result = rememberMemoryFact(ctx.workspace, content, bank);
    if (result.ok === false) {
      if (result.reason === "empty") return fail("content is required");
      if (result.reason === "too_long") return fail(`content exceeds ${MEMORY_FACT_MAX_CHARS} chars`);
      return { ok: true, output: `no change (duplicate fact in bank ${bank})` };
    }
    return { ok: true, output: `remembered in bank ${result.bank}` };
  },
};

export const memoryForgetTool: Tool = {
  name: "memory_forget",
  description:
    "Remove facts from a memory bank. Provide exact content and/or a BM25 query (same token rules as memory_search). At least one of content or query is required.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Exact fact text to delete." },
      query: { type: "string", description: "Search terms; deletes up to limit matching facts." },
      bank: { type: "string", enum: ["project", "user", "shared"] },
      limit: { type: "number", description: "Max rows removed when using query (default 8)." },
    },
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "forget", "delete", "recall", "bank"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const bank = parseBankArg(args.bank) ?? PROJECT_BANK;
    if (args.bank !== undefined && parseBankArg(args.bank) === undefined) return fail("invalid bank");
    const content = typeof args.content === "string" ? args.content : undefined;
    const query = typeof args.query === "string" ? args.query : undefined;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
    if ((content === undefined || content.trim() === "") && (query === undefined || query.trim() === "")) {
      return fail("content or query is required");
    }
    const { deleted, removed } = forgetMemoryFacts(ctx.workspace, { bank, content, query, limit });
    if (deleted === 0) return { ok: true, output: `no matching facts in bank ${bank}` };
    const preview = removed.map((r) => `- ${r.slice(0, 120)}${r.length > 120 ? "…" : ""}`).join("\n");
    return { ok: true, output: `forgot ${deleted} fact(s) in bank ${bank}:\n${preview}` };
  },
};
